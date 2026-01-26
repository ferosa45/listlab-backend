import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../src/lib/prisma.js";
import { setAuthCookie } from "../utils/authCookies.js";
import { requireAuth } from "../src/middleware/authMiddleware.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * POST /api/schools/:id/invites
 * Vytvoření pozvánky pro učitele
 */
router.post("/schools/:id/invites", requireAuth, async (req, res) => {
  console.log("INVITE DEBUG user:", req.user);
  
  if (!req.user) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  try {
    const { email } = req.body;
    const schoolId = req.params.id;
    const user = req.user;

    if (!email) {
      return res.status(400).json({ error: "EMAIL_REQUIRED" });
    }

    // 🔐 pouze SCHOOL_ADMIN
    if (user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    if (user.schoolId !== schoolId) {
      return res.status(403).json({ error: "NOT_YOUR_SCHOOL" });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      include: { users: true }
    });

    if (!school) {
      return res.status(404).json({ error: "SCHOOL_NOT_FOUND" });
    }

    // 🎫 seat limit
    if (school.seatLimit) {
      const teachers = school.users.filter(u => u.role === "TEACHER");
      if (teachers.length >= school.seatLimit) {
        return res.status(409).json({ error: "SEAT_LIMIT_REACHED" });
      }
    }

    // ♻️ existující aktivní invite (pokud už existuje, jen ho obnovíme, nebo vyhodíme chybu)
    const existingInvite = await prisma.schoolInvite.findFirst({
      where: {
        email,
        schoolId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (existingInvite) {
      return res.status(409).json({ error: "INVITE_ALREADY_EXISTS" });
    }

    // 🔐 Generování tokenu
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dní

    // Zápis do DB
    const invite = await prisma.schoolInvite.create({
      data: {
        email,
        token,
        schoolId,
        invitedById: user.id,
        expiresAt
      }
    });

    // 📧 ODESLÁNÍ EMAILU (Výpis do konzole)
    await sendInviteEmail(email, token, school.name);

    return res.json({ ok: true, inviteId: invite.id });

  } catch (err) {
    console.error("CREATE INVITE ERROR:", err);
    return res.status(500).json({ error: "CREATE_INVITE_FAILED" });
  }
});

/**
 * GET /api/invites/:token
 * Veřejná validace pozvánky (když uživatel klikne na odkaz v emailu)
 */
router.get("/invites/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await prisma.schoolInvite.findUnique({
      where: { token },
      include: {
        school: {
          select: { name: true }
        }
      }
    });

    if (!invite) {
      return res.status(404).json({ valid: false, error: "INVITE_NOT_FOUND" });
    }
    if (invite.revokedAt) {
      return res.status(400).json({ valid: false, error: "INVITE_REVOKED" });
    }
    if (invite.acceptedAt) {
      return res.status(400).json({ valid: false, error: "INVITE_ALREADY_ACCEPTED" });
    }
    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ valid: false, error: "INVITE_EXPIRED" });
    }

    // ✅ OK
    return res.json({
      valid: true,
      email: invite.email,
      schoolName: invite.school.name,
      expiresAt: invite.expiresAt
    });

  } catch (err) {
    console.error("GET INVITE ERROR:", err);
    return res.status(500).json({ valid: false, error: "GET_INVITE_FAILED" });
  }
});

/**
 * POST /api/invites/:token/accept
 * Přijmutí pozvánky (uživatel je přihlášen a klikne "Přijmout")
 */
router.post("/invites/:token/accept", requireAuth, async (req, res) => {
  const { token } = req.params;
  const user = req.user; // Zde už máme usera díky requireAuth

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ načti invite
      const invite = await tx.schoolInvite.findUnique({
        where: { token },
      });

      if (!invite) throw { status: 404, error: "INVITE_NOT_FOUND" };
      if (invite.revokedAt) throw { status: 400, error: "INVITE_REVOKED" };
      if (invite.acceptedAt) throw { status: 400, error: "INVITE_ALREADY_ACCEPTED" };
      if (invite.expiresAt < new Date()) throw { status: 400, error: "INVITE_EXPIRED" };

      // 2️⃣ email musí sedět
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        throw { status: 403, error: "EMAIL_MISMATCH" };
      }

      // 3️⃣ uživatel nesmí být v jiné škole (volitelné, podle logiky appky)
      const dbUser = await tx.user.findUnique({ where: { id: user.id } });
      if (dbUser.schoolId && dbUser.schoolId !== invite.schoolId) {
        throw { status: 400, error: "USER_ALREADY_IN_SCHOOL" };
      }

      // 4️⃣ seat limit check (znovu pro jistotu)
      const school = await tx.school.findUnique({
        where: { id: invite.schoolId },
        include: { users: { where: { role: "TEACHER" } } },
      });

      if (school.seatLimit && school.users.length >= school.seatLimit) {
        throw { status: 409, error: "SEAT_LIMIT_REACHED" };
      }

      // 5️⃣ UPDATE USER
      await tx.user.update({
        where: { id: user.id },
        data: { schoolId: invite.schoolId, role: "TEACHER" },
      });

      // 6️⃣ UPDATE INVITE
      await tx.schoolInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      return { schoolId: invite.schoolId };
    });

    // 🔁 Refresh tokenu (protože se změnila role/schoolId)
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    const newToken = jwt.sign(
      {
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        schoolId: updatedUser.schoolId,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 🍪 MÍSTO setAuthCookie(res, newToken) DÁME PŘÍMÝ ZÁPIS:
    res.cookie("token", newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // Na produkci (HTTPS) true, jinak false
      sameSite: "lax", // Pro auth cookies je často lepší 'lax' nebo 'strict'
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dní
      path: "/",
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error("ACCEPT INVITE ERROR:", err);
    const status = err.status || 500;
    const msg = err.error || "ACCEPT_INVITE_FAILED";
    return res.status(status).json({ error: msg });
  }
});

// ------------------------------------------------------------------
// 📧 Pomocná funkce pro logování/odeslání emailu
// ------------------------------------------------------------------
async function sendInviteEmail(toEmail, token, schoolName) {
    // Zde definuj URL svého frontendu. Na localhostu to je 5173, na produkci tvoje doména.
    const frontendUrl = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
    const inviteLink = `${frontendUrl}/invite/${token}`;
    
    console.log("\n==================================================");
    console.log(`📧 MOCK EMAIL PRO: ${toEmail}`);
    console.log(`🏫 ŠKOLA: ${schoolName}`);
    console.log(`🔗 ODKAZ: ${inviteLink}`);
    console.log("==================================================\n");

    // Zde bys v budoucnu volal resend.emails.send(...)
}

export default router;