// api/server.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./src/lib/prisma.js"
import PDFDocument from "pdfkit";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { body, validationResult } from "express-validator";
import { fileURLToPath } from "url";
import stripeWebhookRouter from './routes/stripeWebhook.js'
import billingRouter from './routes/billing.js'

// ---------- CUSTOM SERVICES & MIDDLEWARE ----------
import { licenseContext } from "./src/middleware/licenseContext.js";
import { checkWorksheetLimit, checkAiLimit } from "./src/middleware/usageLimits.js";
import {
  incrementWorksheetUsage,
  incrementAiUsage
} from "./src/services/usageService.js";
import { getActiveSubscriptionForUserOrSchool } from "./src/services/subscriptionService.js";
import { ENTITLEMENTS } from "./src/config/entitlements.js";

dotenv.config();

// ---------- PATHS ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- INIT ----------
const app = express();


// ---------- CONFIG ----------
const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const NODE_ENV = process.env.NODE_ENV || "development";

// ---------- GLOBAL MIDDLEWARE ----------
app.use(
  cors({
    origin: [FRONTEND_ORIGIN, "http://localhost:5173"],
    credentials: true,
  })
);

// ✅ STRIPE WEBHOOK – musí být před express.json()
app.use('/api/stripe/webhook', stripeWebhookRouter)

app.use(express.json())
app.use(cookieParser())

// ---------- COOKIE HELPERS ----------
function setAuthCookie(res, token) {
  const isHttps =
  FRONTEND_ORIGIN.startsWith("https://");

res.cookie("token", token, {
  httpOnly: true,
  secure: isHttps,                  // 🔥 KLÍČOVÉ
  sameSite: isHttps ? "None" : "Lax",
  path: "/",
});

}

function clearAuthCookie(res) {
  const isProd = NODE_ENV === "production";

  res.clearCookie("token", {
    secure: isProd,
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

// ---------- HEALTH ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Health OK", time: new Date().toISOString() });
});

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
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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

// ---------- SET PASSWORD (cookie-based) ----------
app.post("/api/auth/set-password", authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PASSWORD",
        message: "Heslo musí mít alespoň 6 znaků."
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    if (user.password) {
      return res.status(400).json({
        ok: false,
        error: "ALREADY_SET",
        message: "Heslo je již nastaveno."
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed }
    });

    res.json({ ok: true });

  } catch (err) {
    console.error("SET PASSWORD ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "SERVER_ERROR"
    });
  }
});



app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email: true,
      role: true,
      schoolId: true,
      password: true
    },
  });

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      schoolId: user.schoolId,
      needsPasswordSetup: !user.password
    }
  });
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ---------- GENERATOR ----------
function generateMockContent(topic, level) {
  return `Téma: ${topic}\nRočník: ${level === "1" ? "1. stupeň" : "2. stupeň"}`;
}

app.post(
  "/api/generate",
  authMiddleware,
  licenseContext,
  checkWorksheetLimit,
  checkAiLimit,
  async (req, res) => {
    try {
      const { topic, level } = req.body;

      // 1) Log pracovního listu
      await prisma.worksheetLog.create({
        data: {
          userId: req.user.id,
          topic: topic || "(nezadáno)",
          level: level || "1",
        },
      });

      // 2) Inkrementace usage limitů
      const usageAfterWorksheet = await incrementWorksheetUsage(
        req.license.ownerType,
        req.license.ownerId
      );

      const usageAfterAi = await incrementAiUsage(
        req.license.ownerType,
        req.license.ownerId
      );

      // 3) Výpočet zbývajících AI generací
      let aiRemaining = null;

      if (req.license.planCode === "FREE") {
        const allowed = 1; // FREE: 1 AI generace denně

        // Zjistit, zda se počítadlo vztahuje k dnešnímu dni
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const updated = new Date(usageAfterAi.updatedAt);
        updated.setHours(0, 0, 0, 0);

        const usedToday =
          today.getTime() === updated.getTime()
            ? usageAfterAi.aiGenerations
            : 0;

        aiRemaining = Math.max(allowed - usedToday, 0);
      }

      // 4) Odpověď
      res.json({
        ok: true,
        result: generateMockContent(topic, level),
        license: {
          ...req.license,
          aiRemaining,
        },
      });

    } catch (err) {
      console.error("/api/generate ERROR:", err);
      res.status(500).json({ ok: false, error: "Generate failed" });
    }
  }
);


// ---------- LICENSE DEBUG ----------
app.get("/api/debug/sub", authMiddleware, licenseContext, (req, res) => {
  res.json({ ok: true, license: req.license });
});

// ---------- LICENSE ----------
app.get("/api/me/license", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // 1) Zjistíme aktivní subscription
    const sub = await getActiveSubscriptionForUserOrSchool(user);
    const planCode = sub?.planCode ?? "FREE";
    const entitlements = ENTITLEMENTS[planCode] ?? ENTITLEMENTS.FREE;

    // 2) Určení vlastníka (USER/SCHOOL)
    const ownerType = user.schoolId ? "SCHOOL" : "USER";
    const ownerId = user.schoolId || user.id;

    // 3) Usage záznam pro aktuální měsíc
    const now = new Date();
    const usage = await prisma.usageLimit.findFirst({
      where: {
        ownerType,
        ownerId,
        year: now.getFullYear(),
        month: now.getMonth() + 1
      }
    });

    let aiRemaining = null;
    let worksheetsRemaining = null;

    // ------------------------------------------------------
    //      FREE PLAN
    // ------------------------------------------------------
    if (planCode === "FREE") {
      const AI_LIMIT = entitlements.maxAiGenerationsPerDay;      // 10
      const WS_LIMIT = entitlements.maxWorksheetsPerMonth;        // 30

      if (usage) {
        // denní limit AI
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const updated = new Date(usage.updatedAt);
        updated.setHours(0, 0, 0, 0);

        const usedToday =
          today.getTime() === updated.getTime()
            ? usage.aiGenerations
            : 0;

        aiRemaining = Math.max(AI_LIMIT - usedToday, 0);

        // měsíční limit worksheets
        worksheetsRemaining = Math.max(WS_LIMIT - usage.worksheetsCount, 0);
      } else {
        // žádný usage záznam → full limity
        aiRemaining = AI_LIMIT;
        worksheetsRemaining = WS_LIMIT;
      }
    }

    // ------------------------------------------------------
    //      PREMIUM / PAID
    // ------------------------------------------------------
    else {
      aiRemaining = null;          // neomezené AI
      worksheetsRemaining = null;  // neomezené worksheets
    }

    res.json({
      ok: true,
      planCode,
      entitlements,
      subscription: sub ?? null,
      aiRemaining,
      worksheetsRemaining,
    });

  } catch (err) {
    console.error("/api/me/license error:", err);
    res.status(500).json({ ok: false, error: "Failed to load license" });
  }
});



// ---------- PDF ----------
const FONT_PATH = path.join(__dirname, "fonts", "DejaVuSans.ttf");

// ---------- PDF (chráněno licencí + worksheet limitem) ----------
// ---------- PDF ----------
app.post("/api/pdf", authMiddleware, licenseContext, async (req, res) => {
  try {
    const { topic, level } = req.body;

    if (!topic || !level) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST",
        message: "Topic a level jsou povinné."
      });
    }

    // ------------------------------------------------------
    // 🔒 FREE user musí mít existující generaci (náhled)
    // ------------------------------------------------------
    if (req.license.planCode === "FREE") {
      const lastGenerated = await prisma.worksheetLog.findFirst({
        where: {
          userId: req.user.id,
          topic,
          level
        }
      });

      if (!lastGenerated) {
        return res.status(400).json({
          ok: false,
          error: "NO_PREVIEW",
          message: "Nejdříve si zobrazte náhled pracovního listu."
        });
      }
    }

    // ------------------------------------------------------
    // 📝 Vytvoření PDF (žák / učitel)
    // ------------------------------------------------------
    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=listlab.pdf");
    doc.pipe(res);

    const FONT_PATH = path.join(__dirname, "fonts", "DejaVuSans.ttf");
    if (fs.existsSync(FONT_PATH)) doc.font(FONT_PATH);

    doc.fontSize(20).text(topic, { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(
      `Téma: ${topic}\nRočník: ${level === "1" ? "1. stupeň" : "2. stupeň"}`
    );

    doc.end();
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({
      ok: false,
      error: "PDF_ERROR",
      message: "Chyba serveru při generování PDF."
    });
  }
});


// ---------- ADMIN ----------
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

  await prisma.user.update({ where: { id }, data: { role } });
  res.json({ ok: true });
});

app.get("/api/admin/stats", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  try {
    const totalUsers = await prisma.user.count();

    const newUsers7days = await prisma.user.count({
      where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
    });

    const totalWorksheets = await prisma.worksheetLog.count();

    const worksheets30days = await prisma.worksheetLog.count({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
    });

    res.json({
      ok: true,
      stats: {
        totalUsers,
        newUsers: newUsers7days,
        totalWorksheets,
        monthlyWorksheets: worksheets30days,
      },
    });
  } catch (err) {
    console.error("ADMIN /stats error:", err);
    res.status(500).json({ error: "Failed to load admin stats" });
  }
});

// ---------- ADMIN: Reset limitů ----------
app.post("/api/admin/reset-limits", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { userId } = req.body; 
  // userId = reset jen jednomu uživateli
  // bez userId = reset všem

  try {
    if (userId) {
      // reset pro 1 uživatele
      await prisma.usageLimit.deleteMany({
        where: { ownerType: "user", ownerId: userId }
      });

      return res.json({ ok: true, message: "Limity uživatele resetovány." });
    }

    // reset všem uživatelům
    await prisma.usageLimit.deleteMany({});

    res.json({ ok: true, message: "Všechny limity byly resetovány." });

  } catch (err) {
    console.error("RESET LIMITS ERROR:", err);
    res.status(500).json({ ok: false, error: "Reset selhal." });
  }
});


// ---------- SCHOOLS ----------
app.get("/api/admin/schools", authMiddleware, async (req, res) => {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Forbidden" });

  const schools = await prisma.school.findMany({
    include: { license: true, users: true },
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
      license: { create: { type: licenseType || "FREE" } },
    },
    include: { license: true },
  });

  res.json({ ok: true, school });
});

// ---------- STRIPE CHECKOUT ----------
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vytvoření checkout session
app.post("/api/billing/create-checkout-session", authMiddleware, async (req, res) => {
  try {
    const { priceId, planCode, billingPeriod } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: "Missing priceId" });
    }

    const user = req.user;

    // Určení vlastníka (user nebo school)
    const ownerType = user.schoolId ? "SCHOOL" : "USER";
    const ownerId = user.schoolId || user.id;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        ownerType,
        ownerId,
        planCode,
        billingPeriod: billingPeriod || "month",
      },
      subscription_data: {
        metadata: {
          ownerType,
          ownerId,
          planCode,
          billingPeriod: billingPeriod || "month",
        },
      },
      success_url: `${process.env.FRONTEND_ORIGIN}/team/success`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/billing/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ---------- Vytvoří draft školy (registrace školy) ----------
app.post("/api/team/create-school", async (req, res) => {
  const { name, adminEmail } = req.body;

  try {
    // Najdeme nebo vytvoříme admina
    let user = await prisma.user.findUnique({ where: { email: adminEmail } });

    if (!user) {
      // nový uživatel = SCHOOL_ADMIN
      user = await prisma.user.create({
        data: {
          email: adminEmail,
          password: "TEMPORARY", // později reset hesla
          role: "SCHOOL_ADMIN"
        }
      });
    } else {
      // existující user = povýšíme ho
      await prisma.user.update({
        where: { id: user.id },
        data: { role: "SCHOOL_ADMIN" }
      });
    }

    // 1) vytvoření školy
    const school = await prisma.school.create({
      data: {
        name,
        seatLimit: 10, // DEFAULT
      }
    });

    // 2) přiřazení admina do školy
    await prisma.user.update({
      where: { id: user.id },
      data: {
        schoolId: school.id
      }
    });

    return res.json({ ok: true, schoolId: school.id });

  } catch (error) {
    console.error("create-school error:", error);
    return res.status(500).json({ error: "Failed to create school" });
  }
});


// ---------- TEAM CHECKOUT – vytvoří Stripe Checkout Session ----------
app.post("/api/team/checkout", async (req, res) => {
  try {
    const { schoolId, plan } = req.body; // plan = "team_monthly" | "team_yearly"

    if (!schoolId || !plan) {
      return res.status(400).json({ error: "Missing schoolId or plan" });
    }

    // 1) Najdeme školu
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) return res.status(404).json({ error: "School not found" });

    // 2) Stripe Customer – pokud neexistuje, vytvoříme
    let stripeCustomerId = school.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        name: school.name,
        metadata: { schoolId }
      });

      stripeCustomerId = customer.id;

      await prisma.school.update({
        where: { id: schoolId },
        data: { stripeCustomerId }
      });
    }

    // 3) Určení Stripe Price
    const priceId =
      plan === "team_yearly"
        ? process.env.STRIPE_TEAM_YEARLY_PRICE_ID
        : process.env.STRIPE_TEAM_MONTHLY_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({ error: "Missing TEAM price IDs in env" });
    }

    // 4) Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_ORIGIN}/team/success?schoolId=${schoolId}`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/team/cancel`,
      metadata: {
        schoolId,
        plan,
        ownerType: "SCHOOL"
      },
      subscription_data: {
        metadata: {
          schoolId,
          plan,
          ownerType: "SCHOOL"
        }
      }
    });

    return res.json({ ok: true, url: session.url });

  } catch (error) {
    console.error("TEAM checkout error:", error);
    return res.status(500).json({ error: "Failed to create TEAM checkout session" });
  }
});


// ---------- Aktivuje školu po zaplacení. ----------
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const schoolId = session.metadata.schoolId;
    const plan = session.metadata.plan;

    try {
      // Načteme Stripe subscription pro získání quantity
const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
const quantity =
  stripeSub.items?.data?.[0]?.quantity &&
  Number(stripeSub.items.data[0].quantity);

await prisma.school.update({
  where: { id: schoolId },
  data: {
    subscriptionStatus: "active",
    subscriptionPlan: plan,
    stripeSubscriptionId: session.subscription,
    subscriptionUntil: new Date(stripeSub.current_period_end * 1000),
    seatLimit: quantity || 10 // pokud Stripe quantity není dostupné
  }
});

      // Vytvoření Subscription záznamu
      await prisma.subscription.create({
        data: {
          ownerType: "SCHOOL",
          ownerId: schoolId,
          planCode: plan,
          billingPeriod: plan.includes("yearly") ? "yearly" : "monthly",
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          stripePriceId: session.amount_total,
          status: "active"
        }
      });

    } catch (e) {
      console.error("Error updating school after checkout:", e);
    }
  }

  if (event.type === "customer.subscription.updated") {
  const sub = event.data.object;

  // quantity = počet sedadel (učitelů)
  const quantity =
    sub.items?.data?.[0]?.quantity && Number(sub.items.data[0].quantity);

  const school = await prisma.school.findFirst({
    where: { stripeSubscriptionId: sub.id }
  });

  if (school) {
    await prisma.school.update({
      where: { id: school.id },
      data: {
        subscriptionStatus: sub.status,
        subscriptionUntil: new Date(sub.current_period_end * 1000),
        seatLimit: quantity || school.seatLimit // fallback
      }
    });

    console.log(
      `Updated school seatLimit → ${quantity} (school: ${school.id})`
    );
  }
}


  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;

    const school = await prisma.school.findFirst({
      where: { stripeSubscriptionId: sub.id }
    });

    if (school) {
      await prisma.school.update({
        where: { id: school.id },
        data: {
          subscriptionStatus: "canceled"
        }
      });
    }
  }

  res.json({ received: true });
});

// ---------- Získání seznamu učitelů školy ----------
app.get("/api/team/teachers", authMiddleware, async (req, res) => {
  try {
    if (!req.user.schoolId) {
      return res.status(403).json({ error: "User is not part of a school" });
    }

    const school = await prisma.school.findUnique({
      where: { id: req.user.schoolId },
      include: { users: true }
    });

    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    return res.json({ ok: true, teachers: school.users });

  } catch (err) {
    console.error("team/teachers error:", err);
    return res.status(500).json({ error: "Failed to load teachers" });
  }
});

// ---------- Přidání učitele do školy ----------

app.post("/api/team/add-teacher", authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) return res.status(400).json({ error: "Missing email" });

    // Musí být school admin
    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ error: "Only school admin can add teachers" });
    }

    const schoolId = req.user.schoolId;

    if (!schoolId) {
      return res.status(400).json({ error: "Admin is not linked to a school" });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      include: { users: true }
    });

    if (!school) return res.status(404).json({ error: "School not found" });

    // Seat limit
    if (school.seatLimit && school.users.length >= school.seatLimit) {
      return res.status(400).json({
        error: "SEAT_LIMIT_REACHED",
        message: `Škola má plný počet licencí (${school.seatLimit}).`
      });
    }

    // Najít nebo vytvořit uživatele
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          password: "TEMPORARY",
          role: "TEACHER"
        }
      });
    }

    // Přiřadit ke škole + aktivovat TEAM licenci
    await prisma.user.update({
      where: { id: user.id },
      data: {
        schoolId,
        subscriptionPlan: "team",
        subscriptionStatus: "active"
      }
    });

    return res.json({ ok: true, user });

  } catch (err) {
    console.error("add-teacher error:", err);
    return res.status(500).json({ error: "Failed to add teacher" });
  }
});

// ---------- TEAM BILLING PORTAL ----------
app.post("/api/team/billing-portal", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // musí být SCHOOL_ADMIN
    if (user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ error: "Only school admins can open billing portal" });
    }

    // načteme školu
    const school = await prisma.school.findUnique({
      where: { id: user.schoolId }
    });

    if (!school || !school.stripeCustomerId) {
      return res.status(400).json({ error: "School does not have Stripe customer" });
    }

    // vytvoření billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: school.stripeCustomerId,
      return_url: `${process.env.FRONTEND_ORIGIN}/school-admin`,
    });

    return res.json({ ok: true, url: session.url });

  } catch (err) {
    console.error("Billing portal error:", err);
    return res.status(500).json({ error: "Failed to create billing portal session" });
  }
});

// ---------- start-registration team ----------
app.post("/api/team/start-registration", async (req, res) => {
  const { schoolName, adminEmail } = req.body;

  if (!schoolName || !adminEmail) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  try {
    // 1) najdeme nebo vytvoříme usera
    let user = await prisma.user.findUnique({
      where: { email: adminEmail }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: adminEmail,
          password: "", // vytvoří se později přes reset hesla
          role: "SCHOOL_ADMIN"
        }
      });
    }

    // 2) vytvoříme JWT token a uložíme cookie
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    setAuthCookie(res, token);

    // 3) vytvoříme školu (zatím bez předplatného)
    const school = await prisma.school.create({
      data: {
        name: schoolName,
        users: { connect: { id: user.id } }
      }
    });

    return res.json({
      ok: true,
      user,
      school
    });

  } catch (e) {
    console.error("start-registration error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- CREATE SCHOOL (FREE USER) ----------
app.post("/api/school/create", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || name.length < 3) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_NAME"
      });
    }

    // už má školu?
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { schoolId: true }
    });

    if (existing.schoolId) {
      return res.status(400).json({
        ok: false,
        error: "ALREADY_HAS_SCHOOL"
      });
    }

    // vytvořit školu
    const school = await prisma.school.create({
      data: {
        name,
        users: {
          connect: { id: userId }
        }
      }
    });

    // povýšit uživatele na SCHOOL_ADMIN
    await prisma.user.update({
      where: { id: userId },
      data: {
        role: "SCHOOL_ADMIN",
        schoolId: school.id
      }
    });

    res.json({
      ok: true,
      schoolId: school.id
    });

  } catch (err) {
    console.error("CREATE SCHOOL ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "CREATE_SCHOOL_FAILED"
    });
  }
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
