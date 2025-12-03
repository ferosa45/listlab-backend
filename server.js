// api/server.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import PDFDocument from "pdfkit";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { body, validationResult } from "express-validator";
import bodyParser from "body-parser";

import { licenseContext } from "./src/middleware/licenseContext.js";
import { getActiveSubscriptionForUserOrSchool } from "./src/services/subscriptionService.js";
import { ENTITLEMENTS } from "./src/config/entitlements.js";

dotenv.config();

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Init
const app = express();
const prisma = new PrismaClient();

// Config
const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// Middleware
app.use(
  cors({
    origin: [FRONTEND_ORIGIN, "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.json());

// ---------- HEALTHCHECK ----------
app.get("/api/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    message: "Health OK",
    time: new Date().toISOString(),
  });
});

// Root
app.get("/", (req, res) => {
  res.send("ListLab backend running ✔");
});

// Helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
  });
}

function clearAuthCookie(res) {
  res.clearCookie("token", {
    secure: true,
    sameSite: "None",
    path: "/",
  });
}

function authMiddleware(req, res, next) {
  try {
    const token =
      req.cookies?.token || req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ----------- AUTH -----------
app.post(
  "/api/auth/register",
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(400).json({ error: "User exists" });

    const hashed = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: { email, password: hashed, role: "TEACHER" },
    });

    const token = signToken({
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    setAuthCookie(res, token);

    res.json({ ok: true, user: newUser });
  }
);

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(400).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: "Invalid credentials" });

  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  setAuthCookie(res, token);

  return res.json({ ok: true, user });
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, role: true, schoolId: true },
  });

  res.json({ ok: true, user });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ----------- GENERATOR (LOG WORKSHEET) -----------
function generateMockContent(topic, level) {
  return `Téma: ${topic}\nRočník: ${
    level === "1" ? "1. stupeň" : "2. stupeň"
  }`;
}

// ----------- GENERATE + LOGGING -----------
// Přidáno licenseContext middleware (KROK 2)
app.post("/api/generate", authMiddleware, licenseContext, async (req, res) => {
  const { topic, level } = req.body;

  // req.license je nyní dostupné
  // můžeš zde později přidat checky pro limits (KROK 3)
  try {
    await prisma.worksheetLog.create({
      data: {
        userId: req.user.id,
        topic: topic || "(nezadáno)",
        level: level || "1",
      },
    });
  } catch (err) {
    console.error("WorksheetLog error:", err);
  }

  // Odpověď teď vrací i info o licenci (pro debug/FE)
  res.json({
    ok: true,
    result: generateMockContent(topic, level),
    license: req.license,
  });
});

// ---------- DEBUG: ověření načtení licence ----------
app.get("/api/debug/sub", authMiddleware, licenseContext, (req, res) => {
  return res.json({
    ok: true,
    license: req.license,
  });
});

// ---------- GET /api/me/license ----------
app.get("/api/me/license", authMiddleware, async (req, res) => {
  try {
    const sub = await getActiveSubscriptionForUserOrSchool(req.user);
    const planCode = sub?.plan_code ?? "FREE";
    const entitlements = ENTITLEMENTS[planCode] ?? ENTITLEMENTS.FREE;

    // TODO: doplníme usageService později
    const usageThisMonth = null;

    return res.json({
      ok: true,
      planCode,
      billingPeriod: sub?.billing_period ?? null,
      validFrom: sub?.valid_from ?? null,
      validTo: sub?.valid_to ?? null,
      entitlements,
      subscription: sub ?? null,
      usageThisMonth,
    });
  } catch (err) {
    console.error("GET /api/me/license error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load license" });
  }
});

// ----------- PDF -----------
const FONT_PATH = path.join(__dirname, "fonts", "DejaVuSans.ttf");

app.post("/api/pdf", (req, res) => {
  const { topic, level } = req.body;

  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=listlab.pdf");
  doc.pipe(res);

  if (fs.existsSync(FONT_PATH)) doc.font(FONT_PATH);

  doc.fontSize(20).text(topic, { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(generateMockContent(topic, level));

  doc.end();
});

// ---------- ADMIN ROUTES ----------
app.get("/api/admin/users", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, createdAt: true, schoolId: true }
  });

  res.json({ ok: true, users });
});

app.post("/api/admin/set-role", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  const { id, role } = req.body;

  await prisma.user.update({
    where: { id },
    data: { role },
  });

  res.json({ ok: true });
});

// ---------- ADMIN STATS (sloučeno, jediný endpoint) ----------
app.get("/api/admin/stats", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });

  const teachers = await prisma.user.count({ where: { role: "TEACHER" } });
  const admins = await prisma.user.count({ where: { role: "ADMIN" } });
  const schools = await prisma.school.count();
  const worksheets = await prisma.worksheet.count();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const week = new Date();
  week.setDate(week.getDate() - 7);

  const logsToday = await prisma.worksheetLog.count({
    where: { createdAt: { gte: today } }
  });

  const logsWeek = await prisma.worksheetLog.count({
    where: { createdAt: { gte: week } }
  });

  res.json({
    ok: true,
    stats: {
      teachers,
      admins,
      schools,
      worksheets,
      logsToday,
      logsWeek,
    },
  });
});

// ---------- SCHOOLS ----------
app.get("/api/admin/schools", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });

  const schools = await prisma.school.findMany({
    include: {
      license: true,
      users: true
    }
  });

  res.json({ ok: true, schools });
});

app.post("/api/admin/schools", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });

  const { name, licenseType } = req.body;

  const school = await prisma.school.create({
    data: {
      name,
      license: {
        create: {
          type: licenseType || "FREE"
        }
      }
    },
    include: { license: true }
  });

  res.json({ ok: true, school });
});

// ---------- WORKSHEET LOGS ----------
app.get("/api/admin/worksheets", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });

  const logs = await prisma.worksheetLog.findMany({
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  res.json({ ok: true, logs });
});

// ---------- LISTEN ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ListLab backend running on PORT=${PORT}`);
});
