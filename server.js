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

dotenv.config();

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Init
const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 8080;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// Middleware
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// HEALTHCHECK
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    db: "skipped",
    time: new Date().toISOString(),
  });
});


// ROOT ROUTE
app.get("/", (req, res) => {
  res.send("ListLab backend running");
});

// Helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  try {
    const token =
      req.cookies?.token || req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// AUTH
app.post(
  "/api/auth/register",
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(400).json({ error: "User exists" });

    const hashed = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: { email, password: hashed, role: "TEACHER" },
    });

    const token = signToken(newUser);
    res.cookie("token", token, { httpOnly: true });

    res.json({ ok: true, user: newUser });
  }
);

// GENERATE
function generateMockContent(topic, level) {
  return `Téma: ${topic}\nRočník: ${level === "1" ? "1. stupeň" : "2. stupeň"}`;
}

app.post("/api/generate", async (req, res) => {
  const { topic, level } = req.body;
  await new Promise((r) => setTimeout(r, 300));
  res.json({ ok: true, result: generateMockContent(topic, level) });
});

// PDF
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

// LISTEN — THIS IS THE FIX
app.listen(PORT, "0.0.0.0", () => {
  console.log(`na portu ${PORT}`);
});
