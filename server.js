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
const NODE_ENV = process.env.NODE_ENV || "development";

// Middleware
app.use(
  cors({
    origin: [FRONTEND_ORIGIN, "http://localhost:5173"],
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// ---------- COOKIE HELPERS ----------
function setAuthCookie(res, token) {
  const isProd = NODE_ENV === "production";

  res.cookie("token", token, {
    httpOnly: true,
    secure: isProd ? true : false,
    sameSite: isProd ? "None" : "Lax",
    path: "/",
  });
}

function clearAuthCookie(res) {
  const isProd = NODE_ENV === "production";

  res.clearCookie("token", {
    secure: isProd ? true : false,
    sameSite: isProd ? "None" : "Lax",
    path: "/",
  });
}

// ---------- AUTH MIDDLEWARE ----------
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

// ---------- HEALTHCHECK ----------
app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "Health OK",
    time: new Date().toISOString(),
  });
});

// Root
app.get("/", (_req, res) => {
  res.send("ListLab backend running ✔");
});

// ---------- AUTH ----------
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

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

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

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  setAuthCookie(res, token);
  res.json({ ok: true, user });
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, role: true, schoolId: true },
  });

  res.json({ ok: true, user });
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ---------- GENERATOR ----------
function generateMockContent(topic, level) {
  return `Téma: ${topic}\nRočník: ${
    level === "1" ? "1. stupeň" : "2. stupeň"
  }`;
}

app.post("/api/generate", authMiddleware, licenseContext, async (req, res) => {
  const { topic, level } = req.body;

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

  res.json({
    ok: true,
    result: generateMockContent(topic, level),
    license: req.license,
  });
});

// ---------- LICENSE DEBUG ----------
app.get("/api/debug/sub", authMiddleware, licenseContext, (req, res) => {
  res.json({ ok: true, license: req.license });
});

// ---------- GET /api/me/license ----------
app.get("/api/me/license", authMiddleware, async (req, res) => {
  try {
    const sub = await getActiveSubscriptionForUserOrSchool(req.user);
    const planCode = sub?.plan_code ?? "FREE";
    const entitlements = ENTITLEMENTS[planCode] ?? ENTITLEMENTS.FREE;

    res.json({
      ok: true,
      planCode,
      billingPeriod: sub?.billing_period ?? null,
      validFrom: sub?.valid_from ?? null,
      validTo: sub?.valid_to ?? null,
      entitlements,
      subscription: sub ?? null,
      usageThisMonth: null,
    });
  } catch (err) {
    console.error("/api/me/license error:", err);
    res.status(500).json({ ok: false, error: "Failed to load license" });
  }
});

// ---------- PDF ----------
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
    select: { id: true, email: true, role: true, createdAt: true, schoolId: true },
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

// ---------- ADMIN STATS (FINAL CORRECT VERSION) ----------
app.get("/api/admin/stats", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  try {
    // Uživatelské statistiky
    const totalUsers = await prisma.user.count();

    const newUsers7days = await prisma.user.count({
      where: {
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      }
    });

    // Worksheet statistiky
    const totalWorksheets = await prisma.worksheetLog.count();

    const worksheets30days = await prisma.worksheetLog.count({
      where: {
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      }
    });

    res.json({
  ok: true,
  stats: {
    totalUsers,
    newUsers: newUsers7days,                 // PRO FRONTEND
    totalWorksheets,
    monthlyWorksheets: worksheets30days      // PRO FRONTEND
  }
});

  } catch (err) {
    console.error("ADMIN /stats error:", err);
    res.status(500).json({ error: "Failed to load admin stats" });
  }
});


// ---------- SCHOOLS ----------
app.get("/api/admin/schools", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  const schools = await prisma.school.findMany({
    include: {
      license: true,
      users: true,
    },
  });

  res.json({ ok: true, schools });
});

app.post("/api/admin/schools", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  const { name, licenseType } = req.body;

  const school = await prisma.school.create({
    data: {
      name,
      license: {
        create: {
          type: licenseType || "FREE",
        },
      },
    },
    include: { license: true },
  });

  res.json({ ok: true, school });
});

// ---------- WORKSHEET LOGS ----------
app.get("/api/admin/worksheets", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  const logs = await prisma.worksheetLog.findMany({
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  res.json({ ok: true, logs });
});

// ---------- LISTEN ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ListLab backend running on PORT=${PORT}`);
});
