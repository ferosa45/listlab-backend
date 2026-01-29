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
import invoiceRoutes from "./routes/invoices.js";
import { generateInvoicePdf } from "./src/services/generateInvoicePdf.js";
import schoolInvitesRouter from "./routes/schoolInvites.js";
import { setAuthCookie } from "./utils/authCookies.js";
// server.js - úplně nahoře mezi importy
// 👇 TOTO JE TEN TRIK: "as authMiddleware"
import { requireAuth as authMiddleware } from "./src/middleware/authMiddleware.js";





// ---------- CUSTOM SERVICES & MIDDLEWAREE ----------
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

// ---------- GLOBAL MIDDLEWAREE ----------
// server.js

app.use(cors({
  origin: 'http://localhost:5173', // Musí být přesná adresa frontendu (ne hvězdička *)
  credentials: true,               // Povoluje cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// ✅ STRIPE WEBHOOK – musí být před express.json()
app.use('/api/stripe/webhook', stripeWebhookRouter)

app.use(express.json())
app.use(cookieParser())
app.use("/api/invoices", invoiceRoutes);
app.use("/api", schoolInvitesRouter);
app.use("/api/billing", billingRouter);


// ---------- COOKIE HELPERS ----------
// function setAuthCookie(res, token) {
//   res.cookie("token", token, {
//     httpOnly: true,
//     secure: true,      // 🔥 MUSÍ BÝT TRUE (Railway = HTTPS)
//     sameSite: "None",  // 🔥 MUSÍ BÝT NONE pro cross-origin
//     path: "/",
//   });
// }


function clearAuthCookie(res) {
  res.clearCookie("token", {
    secure: true,
    sameSite: "None",
    path: "/",
  });
}


/* // ---------- AUTH MIDDLEWARE ----------
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
} */


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

    setAuthCookie(req, res, token);

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

  setAuthCookie(req, res, token);

 res.json({
  ok: true,
  user: {
    id: user.id,
    email: user.email,
    role: user.role,
    schoolId: user.schoolId,
  },
  token, // 🔑 TOTO JE TEN CHYBĚJÍCÍ KOUSEK
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

/* // Vytvoření checkout session
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
}); */



// ---------- TEAM CHECKOUT – activation + upgrade ----------
// ---------- TEAM CHECKOUT – FIRST ACTIVATION ONLY ----------
app.post("/api/team/checkout", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // --------------------------------------------------
    // 🔒 NEKOMPROMISNÍ BLOKACE
    // --------------------------------------------------
    if (!user.schoolId || user.role !== "SCHOOL_ADMIN") {
      console.warn("❌ BLOCKED TEAM CHECKOUT:", {
        userId: user.id,
        role: user.role,
        schoolId: user.schoolId,
      });

      return res.status(400).json({
        ok: false,
        error: "SCHOOL_REQUIRED_BEFORE_TEAM_CHECKOUT",
      });
    }

    // --------------------------------------------------
    // 📥 DATA Z FE
    // --------------------------------------------------
    const { plan } = req.body;

    if (!plan || !["team_monthly", "team_yearly"].includes(plan)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PLAN",
      });
    }

    // --------------------------------------------------
    // 🧾 MAPOVÁNÍ PLAN → PRICE ID
    // --------------------------------------------------
    const PRICE_MAP = {
      team_monthly: process.env.STRIPE_TEAM_MONTHLY_PRICE_ID,
      team_yearly: process.env.STRIPE_TEAM_YEARLY_PRICE_ID,
    };

    const priceId = PRICE_MAP[plan];

    if (!priceId) {
      return res.status(500).json({
        ok: false,
        error: "PRICE_NOT_CONFIGURED",
      });
    }

    // --------------------------------------------------
    // 🏫 IDENTITA ŠKOLY
    // --------------------------------------------------
    const schoolId = user.schoolId;

    // --------------------------------------------------
    // 💳 STRIPE CHECKOUT SESSION
    // --------------------------------------------------
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 10,
        },
      ],
      metadata: {
        ownerType: "SCHOOL",
        ownerId: schoolId,   // může zůstat
        schoolId: schoolId,  // 🔥 KLÍČOVÉ
        planCode: "TEAM",
        billingPeriod: plan === "team_yearly" ? "year" : "month",
      },
      subscription_data: {
        metadata: {
          ownerType: "SCHOOL",
          ownerId: schoolId,
          schoolId: schoolId, // 🔥 MUSÍ BÝT I TADY
          planCode: "TEAM",
          billingPeriod: plan === "team_yearly" ? "year" : "month",
        },
      },
      success_url: `${process.env.FRONTEND_ORIGIN}/team/success`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/billing/cancel`,
    });

    return res.json({
      ok: true,
      url: session.url,
    });

  } catch (err) {
    console.error("TEAM CHECKOUT ERROR:", err);
    return res.status(500).json({
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


async function generateInvoiceNumber(tx) {
  const year = new Date().getFullYear();

  const last = await tx.invoice.findFirst({
    where: { year },
    orderBy: { sequence: "desc" },
  });

  const sequence = last ? last.sequence + 1 : 1;

  const number = `LL-${year}-${String(sequence).padStart(4, "0")}`;

  return { year, sequence, number };
}



// ---------- Aktivuje školu po zaplacení. ----------




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

    // minimální validace
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

    // ✅ pouze uložení do DB
    await prisma.school.update({
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
    });

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

    setAuthCookie(req, res, token);

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

    setAuthCookie(req, res, token);

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

// ---------- SEZNAM FAKTURR ----------
app.get("/api/invoices", authMiddleware, async (req, res) => {
   // 🔎 DEBUG – KRITICKÉ LOGY
  console.log("AUTH HEADER:", req.headers.authorization);
  console.log("COOKIES:", req.cookies);
  console.log("REQ.USER:", req.user);
  
  try {
    // 🔐 jen admin školy
    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
      });
    }

    if (!req.user.schoolId) {
      return res.status(400).json({
        ok: false,
        error: "NO_SCHOOL",
      });
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        schoolId: req.user.schoolId,
      },
      orderBy: {
        issuedAt: "desc",
      },
    });

    res.json({
      ok: true,
      invoices,
    });
  } catch (err) {
    console.error("INVOICES LIST ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "INVOICES_LIST_FAILED",
    });
  }
});


// ---------- API ENDPOINT PRO PDF FAKTURU ----------

app.get("/api/invoices/:id/pdf", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await prisma.invoice.findUnique({
      where: { id },
    });

    if (!invoice) {
      return res.status(404).json({ ok: false });
    }

    // 🔐 pouze admin své školy
    if (
      req.user.role !== "SCHOOL_ADMIN" ||
      req.user.schoolId !== invoice.schoolId
    ) {
      return res.status(403).json({ ok: false });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=faktura-${invoice.number}.pdf`
    );

    const doc = generateInvoicePdf(invoice);

    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error("PDF ERROR:", err);
    res.status(500).json({ ok: false });
  }
});


// ------------------------------------------------------------------
// 🏫 GET /api/schools/:id - Detail školy a seznam učitelů
// ------------------------------------------------------------------
app.get("/api/schools/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // 1. Bezpečnostní kontrola: Uživatel musí patřit do této školy
    if (user.schoolId !== id && user.role !== "SUPERADMIN") {
      return res.status(403).json({ 
        ok: false, 
        error: "Nemáte oprávnění prohlížet data této školy." 
      });
    }

    // 2. Načtení školy z DB vč. učitelů
    const school = await prisma.school.findUnique({
      where: { id },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            role: true,
            createdAt: true,
            // Heslo nikdy neposíláme!
          },
          orderBy: { createdAt: 'desc' } // Seřadit od nejnovějších
        }
      }
    });

    if (!school) {
      return res.status(404).json({ ok: false, error: "Škola nenalezena" });
    }

    // 3. Odeslání odpovědi
    res.json({
      ok: true,
      school: {
        ...school,
        // Pokud chceš poslat i kolik zbývá licencí:
        usersCount: school.users.length
      }
    });

  } catch (err) {
    console.error("❌ CHYBA NAČÍTÁNÍ ŠKOLY:", err);
    res.status(500).json({ ok: false, error: "Nepodařilo se načíst data školy." });
  }
});

// ------------------------------------------------------------------
// 🏫 GET /api/schools/:id - Detail školy, učitelé a STATISTIKY
// ------------------------------------------------------------------
app.get("/api/schools/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // 1. Bezpečnost
    if (user.schoolId !== id && user.role !== "SUPERADMIN") {
      return res.status(403).json({ ok: false, error: "Bez oprávnění" });
    }

    // 2. Načtení školy a učitelů
    const school = await prisma.school.findUnique({
      where: { id },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            role: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!school) return res.status(404).json({ ok: false, error: "Škola nenalezena" });

    // 3. 🔥 VÝPOČET STATISTIK (AGREGACE)
    // Spočítáme logy všech uživatelů, kteří patří do této školy
    const totalWorksheets = await prisma.worksheetLog.count({
      where: {
        user: {
          schoolId: id
        }
      }
    });

    // Spočítáme počet učitelů (bez adminů, pokud chceš, nebo všechny)
    const teachersCount = school.users.length;
    
    // Zbývající licence
    const seatLimit = school.seatLimit || 0; // Pokud null, tak 0 (nebo Infinity)
    const seatsUsed = teachersCount;
    const seatsAvailable = seatLimit > 0 ? (seatLimit - seatsUsed) : "∞";

    // 4. Odeslání
    res.json({
      ok: true,
      school: {
        ...school,
        stats: {
          totalWorksheets,  // Počet vygenerovaných listů
          seatsUsed,        // Obsazená místa
          seatsAvailable,   // Volná místa
          seatLimit         // Celkový limit
        }
      }
    });

  } catch (err) {
    console.error("❌ CHYBA ŠKOLY:", err);
    res.status(500).json({ ok: false, error: "Chyba serveru" });
  }
});

// ------------------------------------------------------------------
// 💾 PUT /api/schools/:id/billing - Aktualizace fakturačních údajů
// ------------------------------------------------------------------
app.put("/api/schools/:id/billing", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const { 
      billingName, billingStreet, billingCity, billingZip, 
      billingCountry, billingIco, billingDic 
    } = req.body;

    // 1. Bezpečnost: Uživatel musí patřit do této školy
    if (user.schoolId !== id && user.role !== "SUPERADMIN") {
      return res.status(403).json({ 
        ok: false, 
        error: "Nemáte oprávnění měnit údaje této školy." 
      });
    }

    // 2. Aktualizace v databázi
    const updatedSchool = await prisma.school.update({
      where: { id },
      data: {
        billingName,
        billingStreet,
        billingCity,
        billingZip,
        billingCountry,
        billingIco,
        billingDic
      }
    });

    // 3. (Volitelné) Pokud už existuje zákazník ve Stripe, aktualizujeme ho taky
    // Aby na příští faktuře byla správná adresa
    if (updatedSchool.stripeCustomerId) {
        try {
            // Musíme importovat Stripe, pokud není v tomto scope dostupný
            // (Předpokládám, že 'stripe' už máš inicializovaný nahoře v server.js)
             await stripe.customers.update(updatedSchool.stripeCustomerId, {
                name: billingName,
                address: {
                    line1: billingStreet,
                    city: billingCity,
                    postal_code: billingZip,
                    country: billingCountry || 'CZ',
                },
                metadata: { ico: billingIco, dic: billingDic }
            });
        } catch (stripeErr) {
            console.warn("⚠️ Nepodařilo se aktualizovat Stripe (nevadí, DB je OK):", stripeErr.message);
        }
    }

    res.json({ ok: true, message: "Údaje uloženy" });

  } catch (err) {
    console.error("❌ CHYBA UKLÁDÁNÍ BILLING:", err);
    res.status(500).json({ ok: false, error: "Nepodařilo se uložit údaje." });
  }
});

// ---------------------------------------------------------
// ODEBRAT UŽIVATELE ZE ŠKOLY
// ---------------------------------------------------------
app.delete('/api/schools/:schoolId/users/:userId', authMiddleware, async (req, res) => {
  try {
    const { schoolId, userId } = req.params;
    const requester = req.user; // Ten, kdo klikl na tlačítko (admin)

    // 1. BEZPEČNOST: Kontrola oprávnění (musí být ADMIN téže školy)
    if (requester.schoolId !== schoolId || requester.role !== 'SCHOOL_ADMIN') {
      return res.status(403).json({ error: "Nemáte oprávnění spravovat uživatele této školy." });
    }

    // 2. POJISTKA: Nemůžeš smazat sám sebe
    if (requester.id === userId) {
      return res.status(400).json({ error: "Nemůžete odebrat sami sebe." });
    }

    // 3. ODPOJENÍ UŽIVATELE
    // Smažeme mu schoolId a vrátíme roli na běžného TEACHER
    await prisma.user.update({
      where: { id: userId },
      data: {
        schoolId: null,
        role: 'TEACHER' 
      }
    });

    console.log(`🗑️ Uživatel ${userId} byl odebrán ze školy ${schoolId}.`);
    res.json({ ok: true, message: "Uživatel byl úspěšně odebrán." });

  } catch (err) {
    console.error("Chyba při odebírání uživatele:", err);
    res.status(500).json({ error: "Nepodařilo se odebrat uživatele." });
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
