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
  res.cookie("token", token, {
    httpOnly: true,
    secure: true,      // 🔥 MUSÍ BÝT TRUE (Railway = HTTPS)
    sameSite: "None",  // 🔥 MUSÍ BÝT NONE pro cross-origin
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


// ---------- AUTH MIDDLEWARE ----------
function authMiddleware(req, res, next) {
  try {
    const token =
      req.cookies?.token ||
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // 🔥 NORMALIZACE – TADY BYLA CHYBA
    req.user = {
      id: decoded.id || decoded.userId,   // ⬅️ KRITICKÉ
      email: decoded.email,
      role: decoded.role,
      schoolId: decoded.schoolId ?? null,
    };

    if (!req.user.id) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
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
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) {
      return res.status(400).json({ ok: false, error: "User exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashed,
        role: "TEACHER",
        schoolId: null, // 🔥 explicitně
      },
    });

    // 🔥 KRITICKÉ: schoolId MUSÍ být v JWT
    const token = jwt.sign(
      {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        schoolId: newUser.schoolId ?? null,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    setAuthCookie(res, token);

    res.json({
      ok: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        schoolId: newUser.schoolId,
      },
    });
  }
);


app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return res.status(400).json({ ok: false, error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(400).json({ ok: false, error: "Invalid credentials" });
  }

  // 🔥 KRITICKÉ: schoolId MUSÍ být v JWT
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      schoolId: user.schoolId ?? null,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  setAuthCookie(res, token);

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      schoolId: user.schoolId,
    },
  });
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
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
        schoolId: true,
        password: true, // jen pro needsPasswordSetup
      },
    });

    if (!user) {
      return res.status(401).json({ ok: false });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        schoolId: user.schoolId,
        needsPasswordSetup: !user.password,
      },
    });
  } catch (err) {
    console.error("AUTH ME ERROR:", err);
    return res.status(500).json({ ok: false });
  }
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

    // --------------------------------------------------
    // 🚫 TVRDÝ ZÁKAZ TEAM PLÁNU
    // --------------------------------------------------
    if (planCode === "TEAM") {
      return res.status(400).json({
        error: "TEAM_NOT_ALLOWED_ON_THIS_ENDPOINT",
      });
    }

    // --------------------------------------------------
    // 👤 TENTO ENDPOINT JE POUZE PRO USER PLÁNY
    // --------------------------------------------------
    const ownerType = "USER";
    const ownerId = user.id;

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
      success_url: `${process.env.FRONTEND_ORIGIN}/billing/success`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/billing/cancel`,
    });

    return res.json({ ok: true, url: session.url });

  } catch (err) {
    console.error("Checkout session error:", err);
    return res.status(500).json({
      ok: false,
      error: "FAILED_TO_CREATE_CHECKOUT_SESSION",
    });
  }
});



// ---------- TEAM CHECKOUT – activation + upgrade ----------
// ---------- TEAM CHECKOUT – FIRST ACTIVATION ONLY ----------
app.post("/api/team/checkout", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user.schoolId || user.role !== "SCHOOL_ADMIN") {
      return res.status(400).json({
        ok: false,
        error: "SCHOOL_REQUIRED_BEFORE_TEAM_CHECKOUT",
      });
    }

    const { plan } = req.body;

    if (!plan || !["team_monthly", "team_yearly"].includes(plan)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PLAN",
      });
    }

    const PRICE_MAP = {
      team_monthly: process.env.STRIPE_TEAM_MONTHLY_PRICE_ID,
      team_yearly: process.env.STRIPE_TEAM_YEARLY_PRICE_ID,
    };

    const priceId = PRICE_MAP[plan];

    // 🏫 škola (potřebujeme stripeCustomerId)
    const school = await prisma.school.findUnique({
      where: { id: user.schoolId },
      select: {
        stripeCustomerId: true,
      },
    });

    if (!school?.stripeCustomerId) {
      return res.status(400).json({
        ok: false,
        error: "SCHOOL_HAS_NO_STRIPE_CUSTOMER",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],

      // 🔥 KLÍČOVÉ
      customer: school.stripeCustomerId,

      customer_update: {
        name: "auto",
        address: "auto",
      },

      line_items: [
        {
          price: priceId,
          quantity: 10,
        },
      ],

      subscription_data: {
        metadata: {
          ownerType: "SCHOOL",
          ownerId: user.schoolId,
          schoolId: user.schoolId,
          planCode: "TEAM",
          billingPeriod: plan === "team_yearly" ? "year" : "month",
        },
      },

      metadata: {
        ownerType: "SCHOOL",
        ownerId: user.schoolId,
        schoolId: user.schoolId,
        planCode: "TEAM",
      },

      success_url: `${process.env.FRONTEND_ORIGIN}/team/success`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/billing/cancel`,
    });

    res.json({
      ok: true,
      url: session.url,
    });

  } catch (err) {
    console.error("TEAM CHECKOUT ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "TEAM_CHECKOUT_FAILED",
    });
  }
});






// ---------- TEAM: GET MY SCHOOL ----------
app.get("/api/team/school", authMiddleware, async (req, res) => {
  try {
    // 🔐 pouze SCHOOL_ADMIN
    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
      });
    }

    if (!req.user.schoolId) {
      return res.status(400).json({
        ok: false,
        error: "USER_HAS_NO_SCHOOL",
      });
    }

    // 🏫 škola + uživatelé
    const school = await prisma.school.findUnique({
      where: { id: req.user.schoolId },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!school) {
      return res.status(404).json({
        ok: false,
        error: "SCHOOL_NOT_FOUND",
      });
    }

    // ⭐ AKTIVNÍ SUBSCRIPTION PRO ŠKOLU
    const subscription = await prisma.subscription.findFirst({
      where: {
        ownerType: "SCHOOL",
        ownerId: school.id,
        status: {
          in: ["active", "trialing", "past_due"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        planCode: true,
        billingPeriod: true, // month / year
        currentPeriodEnd: true,
        seatLimit: true,
        status: true,
      },
    });

    // ⭐ NOVÉ: má škola vyplněné povinné fakturační údaje?
    const hasBillingDetails =
      !!school.billingName &&
      !!school.billingStreet &&
      !!school.billingCity &&
      !!school.billingZip &&
      !!school.billingCountry;

    return res.json({
      ok: true,
      school: {
        ...school,

        // sjednocené info
        subscriptionPlan: school.subscriptionPlan,
        subscriptionStatus: school.subscriptionStatus,
        subscriptionUntil: school.subscriptionUntil,
        seatLimit: school.seatLimit,

        // detail subscription
        subscription: subscription
          ? {
              planCode: subscription.planCode,
              billingPeriod: subscription.billingPeriod,
              currentPeriodEnd: subscription.currentPeriodEnd,
              seatLimit: subscription.seatLimit,
              status: subscription.status,
            }
          : null,

        // ⭐ FLAG PRO FRONTEND
        hasBillingDetails,

        // ⭐ FAKTURAČNÍ ÚDAJE
        billing: {
          name: school.billingName,
          street: school.billingStreet,
          city: school.billingCity,
          zip: school.billingZip,
          country: school.billingCountry,
          ico: school.billingIco,
          dic: school.billingDic,
          email: school.billingEmail,
        },
      },
    });
  } catch (err) {
    console.error("GET TEAM SCHOOL ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "GET_TEAM_SCHOOL_FAILED",
    });
  }
});




// ---------- Aktivuje školu po zaplacení. ----------
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err);
      return res.sendStatus(400);
    }

    // 🔔 ABSOLUTNĚ KLÍČOVÝ LOG
    console.log("🔔 STRIPE WEBHOOK RECEIVED:", event.type);

    // --------------------------------------------------
    // ✅ CHECKOUT COMPLETED → vytvoření TEAM subscription
    // --------------------------------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      console.log("✅ checkout.session.completed RECEIVED");
      console.log("📦 SESSION METADATA:", session.metadata);
      console.log("🧾 SESSION.SUBSCRIPTION:", session.subscription);
      console.log("👤 SESSION.CUSTOMER:", session.customer);

      if (session.mode === "subscription") {
        const {
          ownerType,
          ownerId,
          planCode,
          billingPeriod
        } = session.metadata || {};

        console.log("➡️ PARSED METADATA:", {
          ownerType,
          ownerId,
          planCode,
          billingPeriod
        });

        try {
          const stripeSub = await stripe.subscriptions.retrieve(
            session.subscription
          );

          console.log("📡 STRIPE SUBSCRIPTION LOADED:", stripeSub.id);

          const quantity = Number(
            stripeSub.items?.data?.[0]?.quantity ?? 1
          );

          console.log("👥 SEAT QUANTITY:", quantity);

          if (ownerType === "SCHOOL") {
            console.log("🏫 UPDATING SCHOOL:", ownerId);

            await prisma.school.update({
              where: { id: ownerId },
              data: {
                stripeCustomerId: stripeSub.customer,
                stripeSubscriptionId: stripeSub.id, // 🔥 KLÍČOVÝ ŘÁDEK
                subscriptionStatus: stripeSub.status,
                subscriptionPlan: planCode,
                subscriptionUntil: new Date(
                  stripeSub.current_period_end * 1000
                ),
                seatLimit: quantity
              }
            });

            console.log("✅ SCHOOL UPDATED WITH SUBSCRIPTION ID");
          } else {
            console.log("⚠️ ownerType IS NOT SCHOOL:", ownerType);
          }

          await prisma.subscription.create({
            data: {
              ownerType,
              ownerId,
              planCode,
              billingPeriod,
              stripeCustomerId: stripeSub.customer,
              stripeSubscriptionId: stripeSub.id,
              stripePriceId: stripeSub.items.data[0].price.id,
              status: stripeSub.status
            }
          });

          console.log("✅ SUBSCRIPTION RECORD CREATED");

        } catch (e) {
          console.error("❌ Error updating school after checkout:", e);
        }
      }
    }

    // --------------------------------------------------
    // 🔁 UPDATE SUBSCRIPTION (změna počtu licencí)
    // --------------------------------------------------
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;

      console.log("🔁 customer.subscription.updated:", sub.id);

      const quantity = Number(
        sub.items?.data?.[0]?.quantity ?? 0
      );

      const school = await prisma.school.findFirst({
        where: { stripeSubscriptionId: sub.id }
      });

      console.log("🏫 SCHOOL FOUND FOR UPDATE:", school?.id);

      if (school) {
        await prisma.school.update({
          where: { id: school.id },
          data: {
            subscriptionStatus: sub.status,
            subscriptionUntil: new Date(
              sub.current_period_end * 1000
            ),
            seatLimit: quantity || school.seatLimit
          }
        });

        console.log(
          `✅ Updated school seatLimit → ${quantity} (school: ${school.id})`
        );
      }
    }

    // --------------------------------------------------
    // ❌ ZRUŠENÍ SUBSCRIPTION
    // --------------------------------------------------
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;

      console.log("❌ customer.subscription.deleted:", sub.id);

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

        console.log("🚫 School subscription canceled:", school.id);
      }
    }

    // --------------------------------------------------
// 🧾 FAKTURA ZAPLACENA → vytvoření INTERNÍ FAKTURY
// --------------------------------------------------
if (event.type === "invoice.paid") {
  const invoice = event.data.object;

  console.log("🧾 invoice.paid:", invoice.id);

  // 🔁 idempotence
  const existing = await prisma.invoice.findUnique({
    where: { stripeInvoiceId: invoice.id },
  });

  if (existing) {
  console.log("↩️ Invoice already exists, skipping");
  return; // ✅ jen return, žádná odpověď
}


  // 🏫 najdeme školu
  const school = await prisma.school.findFirst({
    where: {
      stripeCustomerId: invoice.customer,
    },
  });

  if (!school) {
    console.warn("⚠️ No school for invoice:", invoice.id);
    return res.json({ received: true });
  }

  // 📦 položky
  const items = invoice.lines.data.map((l) => ({
    description: l.description,
    quantity: l.quantity ?? 1,
    amount: l.amount,
  }));

  // 🧾 vytvoření vlastní faktury
  await prisma.invoice.create({
    data: {
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: invoice.subscription,
      stripeCustomerId: invoice.customer,
      number: invoice.number,
      status: "PAID",
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      issuedAt: new Date(invoice.created * 1000),

      schoolId: school.id,

      // 🔥 SNAPSHOT FAKTURAČNÍCH ÚDAJŮ
      billingName: school.billingName,
      billingStreet: school.billingStreet,
      billingCity: school.billingCity,
      billingZip: school.billingZip,
      billingCountry: school.billingCountry,
      billingIco: school.billingIco,
      billingEmail: school.billingEmail,

      items,
    },
  });

  console.log("✅ Internal invoice created:", invoice.number);
}


    res.json({ received: true });
  }
);



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
// ---------- TEAM BILLING PORTAL ----------
app.post("/api/team/billing", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    if (!user.schoolId) {
      return res.status(400).json({ ok: false, error: "USER_HAS_NO_SCHOOL" });
    }

    const {
      billingName,
      billingStreet,
      billingCity,
      billingZip,
      billingCountry,
      billingIco,
      billingEmail,
    } = req.body;

    // ✅ minimální validace (BEZ DIČ)
    if (
      !billingName ||
      !billingStreet ||
      !billingCity ||
      !billingZip ||
      !billingCountry
    ) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
      });
    }

    // 1️⃣ uložení do DB
    const school = await prisma.school.update({
      where: { id: user.schoolId },
      data: {
        billingName,
        billingStreet,
        billingCity,
        billingZip,
        billingCountry,
        billingIco,
        billingEmail,
      },
      select: {
        stripeCustomerId: true,
      },
    });

    let stripeCustomerId = school.stripeCustomerId;

// ⭐ pokud customer ještě neexistuje → vytvoříme ho
if (!stripeCustomerId) {
  const customer = await stripe.customers.create({
    name: billingName,
    email: billingEmail || undefined,
    address: {
      line1: billingStreet,
      city: billingCity,
      postal_code: billingZip,
      country: billingCountry,
    },
    metadata: {
      schoolId: user.schoolId,
      ico: billingIco || "",
    },
  });

  stripeCustomerId = customer.id;

  // uložíme ID do DB
  await prisma.school.update({
    where: { id: user.schoolId },
    data: {
      stripeCustomerId,
    },
  });
}


    // 2️⃣ sync do Stripe (jen BUSINESS údaje)
    // 2️⃣ sync do Stripe (jen BUSINESS údaje)
if (stripeCustomerId) {
  try {
    await stripe.customers.update(stripeCustomerId, {
      name: billingName,
      email: billingEmail || undefined,
      address: {
        line1: billingStreet,
        city: billingCity,
        postal_code: billingZip,
        country: billingCountry,
      },
      metadata: {
        ico: billingIco || "",
      },
    });
  } catch (stripeErr) {
    console.warn(
      "⚠️ Stripe customer update failed:",
      stripeErr.message
    );
  }
}


    return res.json({ ok: true });
  } catch (err) {
    console.error("SAVE BILLING ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "SAVE_BILLING_FAILED",
    });
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
    console.log("CREATE SCHOOL req.user =", req.user);

    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const { name } = req.body;
    if (!name || name.length < 3) {
      return res.status(400).json({ ok: false, error: "INVALID_NAME" });
    }

    // 🔥 vždy si načti usera z DB
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({ ok: false, error: "USER_NOT_FOUND" });
    }

    if (user.schoolId) {
      return res.status(400).json({ ok: false, error: "ALREADY_HAS_SCHOOL" });
    }

    // --------------------------------------------------
    // 🏫 ATOMICKÉ VYTVOŘENÍ ŠKOLY + ADMINA
    // --------------------------------------------------
    const result = await prisma.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name,
        },
      });

      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          role: "SCHOOL_ADMIN",
          schoolId: school.id,
        },
      });

      return { school, updatedUser };
    });

    const { school, updatedUser } = result;

    // --------------------------------------------------
    // 🔐 NOVÝ TOKEN (KRITICKÉ)
    // --------------------------------------------------
    const token = jwt.sign(
      {
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        schoolId: updatedUser.schoolId,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    setAuthCookie(res, token);

    return res.json({
      ok: true,
      schoolId: school.id,
    });

  } catch (err) {
    console.error("CREATE SCHOOL ERROR:", err);
    res.status(500).json({ ok: false, error: "CREATE_SCHOOL_FAILED" });
  }
});


// ---------- TEAM: GET MY SCHOOOOL ----------
app.get("/api/team/school", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
      });
    }

    if (!req.user.schoolId) {
      return res.status(400).json({
        ok: false,
        error: "USER_HAS_NO_SCHOOL",
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: req.user.schoolId },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1, // 👉 poslední aktivní subscription
        },
      },
    });

    if (!school) {
      return res.status(404).json({
        ok: false,
        error: "SCHOOL_NOT_FOUND",
      });
    }

    const subscription = school.subscriptions?.[0] || null;

    res.json({
      ok: true,
      school: {
        id: school.id,
        name: school.name,
        seatLimit: school.seatLimit,
        subscriptionPlan: school.subscriptionPlan,
        subscriptionStatus: school.subscriptionStatus,
        subscriptionUntil: school.subscriptionUntil,

        subscription: subscription
          ? {
              billingPeriod: subscription.billingPeriod,
              status: subscription.status,
              currentPeriodEnd: subscription.currentPeriodEnd,
            }
          : null,

        users: school.users,
      },
    });
  } catch (err) {
    console.error("GET TEAM SCHOOL ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "GET_TEAM_SCHOOL_FAILED",
    });
  }
});

// 🔼 UPDATE TEAM SEATS
app.post("/api/team/update-seats", authMiddleware, async (req, res) => {
  try {
    console.log("USER:", req.user);

    const { seatCount } = req.body;

    if (!seatCount || seatCount < 1) {
      return res.status(400).json({ ok: false, error: "INVALID_SEAT_COUNT" });
    }

    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const school = await prisma.school.findUnique({
      where: { id: req.user.schoolId },
    });

    console.log("SCHOOL:", school);

    if (!school?.stripeSubscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "NO_ACTIVE_SUBSCRIPTION",
      });
    }

    // 1️⃣ načteme subscription
    const subscription = await stripe.subscriptions.retrieve(
      school.stripeSubscriptionId
    );

    const item = subscription.items.data[0];
    const itemId = item.id;
    const currentQuantity = item.quantity;

    // 🔥 ROZHODNUTÍ: zvyšujeme nebo snižujeme?
    const isDecrease = seatCount < currentQuantity;

    // 2️⃣ update quantity
    await stripe.subscriptions.update(subscription.id, {
      items: [
        {
          id: itemId,
          quantity: seatCount,
        },
      ],
      proration_behavior: isDecrease
        ? "none"               // 🔽 snížení → bez refundu
        : "create_prorations", // 🔼 zvýšení → okamžitý doplatek
    });

    // 3️⃣ pokud jsme zvyšovali, dohledáme invoice
    let invoice = null;

    if (!isDecrease) {
      const invoices = await stripe.invoices.list({
        subscription: subscription.id,
        limit: 1,
      });

      invoice = invoices.data[0] ?? null;
    }

    return res.json({
      ok: true,
      isDecrease,

      invoice: invoice
        ? {
            id: invoice.id,
            hostedUrl: invoice.hosted_invoice_url,
            pdfUrl: invoice.invoice_pdf,
            amountPaid: invoice.amount_paid,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
            status: invoice.status,
          }
        : null,
    });
  } catch (err) {
    console.error("UPDATE SEATS ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "UPDATE_SEATS_FAILED",
    });
  }
});


app.post("/api/team/preview-seat-change", authMiddleware, async (req, res) => {
  const { seatCount } = req.body;

  const school = await prisma.school.findUnique({
    where: { id: req.user.schoolId },
  });

  const subscription = await stripe.subscriptions.retrieve(
    school.stripeSubscriptionId
  );

  const itemId = subscription.items.data[0].id;


  res.json({
    ok: true,
    currency: invoice.currency,
  });
});


// ---------- zobrazení faktury ----------

app.get("/api/team/invoices", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
      });
    }

    if (!user.schoolId) {
      return res.status(400).json({
        ok: false,
        error: "USER_HAS_NO_SCHOOL",
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: user.schoolId },
      select: {
        stripeCustomerId: true,
      },
    });

    // 🔑 škola ještě nikdy neplatila → žádné faktury
    if (!school?.stripeCustomerId) {
      return res.json({
        ok: true,
        invoices: [],
      });
    }

    const invoices = await stripe.invoices.list({
      customer: school.stripeCustomerId,
      limit: 20,
    });

    const formatted = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountPaid: inv.amount_paid,
      amountDue: inv.amount_due,
      currency: inv.currency,
      hostedUrl: inv.hosted_invoice_url,
      pdfUrl: inv.invoice_pdf,
      createdAt: new Date(inv.created * 1000),
    }));

    return res.json({
      ok: true,
      invoices: formatted,
    });
  } catch (err) {
    console.error("❌ GET INVOICES ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "FAILED_TO_LOAD_INVOICES",
    });
  }
});


// ---------- API – uložení fakturačních údajů ----------
app.post("/api/team/billing-details", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const {
      billingName,
      billingStreet,
      billingCity,
      billingZip,
      billingCountry,
      billingIco,
      billingDic,
      billingEmail,
    } = req.body;

    await prisma.school.update({
      where: { id: req.user.schoolId },
      data: {
        billingName,
        billingStreet,
        billingCity,
        billingZip,
        billingCountry,
        billingIco,
        billingDic,
        billingEmail,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("BILLING DETAILS ERROR:", err);
    res.status(500).json({ ok: false, error: "SAVE_FAILED" });
  }
});

// ---------- Vrátí fakturační údaje školy (pro předvyplnění formuláře). ----------

app.get("/api/team/billing", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    if (!user.schoolId) {
      return res.status(400).json({ ok: false, error: "USER_HAS_NO_SCHOOL" });
    }

    const school = await prisma.school.findUnique({
      where: { id: user.schoolId },
      select: {
        billingName: true,
        billingStreet: true,
        billingCity: true,
        billingZip: true,
        billingCountry: true,
        billingIco: true,
        billingDic: true,
        billingEmail: true,
      },
    });

    return res.json({
      ok: true,
      billing: school,
    });
  } catch (err) {
    console.error("GET BILLING ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "GET_BILLING_FAILED",
    });
  }
});

// ---------- Uloží údaje do DBB a případně je pošle do Stripe. ----------
app.post("/api/team/billing", authMiddleware, async (req, res) => { 
  try {
    const user = req.user;

    if (user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    if (!user.schoolId) {
      return res.status(400).json({ ok: false, error: "USER_HAS_NO_SCHOOL" });
    }

    const {
      billingName,
      billingStreet,
      billingCity,
      billingZip,
      billingCountry,
      billingIco,
      billingDic,
      billingEmail,
    } = req.body;

    if (!billingName || !billingStreet || !billingCity || !billingZip || !billingCountry) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
      });
    }

    // 1️⃣ DB
    const school = await prisma.school.update({
      where: { id: user.schoolId },
      data: {
        billingName,
        billingStreet,
        billingCity,
        billingZip,
        billingCountry,
        billingIco,
        billingDic,
        billingEmail,
      },
      select: {
        stripeCustomerId: true,
      },
    });

    // 2️⃣ Stripe
    if (school.stripeCustomerId) {
      try {
        // customer info
        await stripe.customers.update(school.stripeCustomerId, {
          name: billingName,
          email: billingEmail || undefined,
          address: {
            line1: billingStreet,
            city: billingCity,
            postal_code: billingZip,
            country: billingCountry,
          },
          metadata: {
            ico: billingIco || "",
          },
        });

        // ⭐ JEDINÉ MÍSTO PRO TAX ID
        if (billingDic) {
          const existing = await stripe.customers.listTaxIds(
            school.stripeCustomerId
          );

          for (const taxId of existing.data) {
            await stripe.customers.deleteTaxId(
              school.stripeCustomerId,
              taxId.id
            );
          }

          await stripe.customers.createTaxId(
            school.stripeCustomerId,
            {
              type: "eu_vat",
              value: billingDic,
            }
          );
        }

      } catch (stripeErr) {
        console.warn("⚠️ Stripe update failed:", stripeErr.message);
      }
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error("SAVE BILLING ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "SAVE_BILLING_FAILED",
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
