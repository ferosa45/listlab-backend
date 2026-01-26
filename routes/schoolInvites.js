import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../src/lib/prisma.js";
import { setAuthCookie } from "../utils/authCookies.js";
import { requireAuth } from "../src/middleware/authMiddleware.js";



const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

router.post(
  "/schools/:id/invites",
  requireAuth,
  async (req, res) => {

    console.log("INVITE DEBUG user:", req.user);

    if (!req.user) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    if (req.user.role !== "SCHOOL_ADMIN") {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    // CREATE INVITE LOGIC
    res.json({ ok: true });
  }
);

/**
 * POST /api/schools/:id/invites
 * vytvoření pozvánky pro učitelee
 */
router.post("/schools/:id/invites", async (req, res) => {
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

    // ♻️ existující aktivní invite
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

    // 🔐 token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invite = await prisma.schoolInvite.create({
      data: {
        email,
        token,
        schoolId,
        invitedById: user.id,
        expiresAt
      }
    });

    // 📧 email pošleme v dalším kroku
    return res.json({ ok: true, inviteId: invite.id });

  } catch (err) {
    console.error("CREATE INVITE ERROR:", err);
    return res.status(500).json({ error: "CREATE_INVITE_FAILED" });
  }
});

/**
 * GET /api/invites/:token
 * veřejná validace pozvánky
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
      return res.status(404).json({
        valid: false,
        error: "INVITE_NOT_FOUND"
      });
    }

    // ❌ zrušená
    if (invite.revokedAt) {
      return res.status(400).json({
        valid: false,
        error: "INVITE_REVOKED"
      });
    }

    // ❌ už použitá
    if (invite.acceptedAt) {
      return res.status(400).json({
        valid: false,
        error: "INVITE_ALREADY_ACCEPTED"
      });
    }

    // ❌ expirovaná
    if (invite.expiresAt < new Date()) {
      return res.status(400).json({
        valid: false,
        error: "INVITE_EXPIRED"
      });
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
    return res.status(500).json({
      valid: false,
      error: "GET_INVITE_FAILED"
    });
  }
});

/**
 * POST /api/invites/:token/accept
 * přijmutí pozvánky do školy
 */
router.post("/invites/:token/accept", async (req, res) => {
  const { token } = req.params;
  const user = req.user;

  try {
    if (!user?.id || !user.email) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ načti invite (lockneme si ho logicky)
      const invite = await tx.schoolInvite.findUnique({
        where: { token },
      });

      if (!invite) {
        throw { status: 404, error: "INVITE_NOT_FOUND" };
      }

      if (invite.revokedAt) {
        throw { status: 400, error: "INVITE_REVOKED" };
      }

      if (invite.acceptedAt) {
        throw { status: 400, error: "INVITE_ALREADY_ACCEPTED" };
      }

      if (invite.expiresAt < new Date()) {
        throw { status: 400, error: "INVITE_EXPIRED" };
      }

      // 2️⃣ email musí sedět
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        throw { status: 403, error: "EMAIL_MISMATCH" };
      }

      // 3️⃣ uživatel nesmí být v jiné škole
      const dbUser = await tx.user.findUnique({
        where: { id: user.id },
      });

      if (!dbUser) {
        throw { status: 401, error: "USER_NOT_FOUND" };
      }

      if (dbUser.schoolId && dbUser.schoolId !== invite.schoolId) {
        throw { status: 400, error: "USER_ALREADY_IN_SCHOOL" };
      }

      // 4️⃣ seat limit (počítáme TEACHERy)
      const school = await tx.school.findUnique({
        where: { id: invite.schoolId },
        include: {
          users: {
            where: { role: "TEACHER" },
            select: { id: true },
          },
        },
      });

      if (!school) {
        throw { status: 404, error: "SCHOOL_NOT_FOUND" };
      }

      if (
        school.seatLimit &&
        school.users.length >= school.seatLimit
      ) {
        throw { status: 409, error: "SEAT_LIMIT_REACHED" };
      }

      // 5️⃣ přiřazení uživatele ke škole
      await tx.user.update({
        where: { id: user.id },
        data: {
          schoolId: invite.schoolId,
          role: "TEACHER",
        },
      });

      // 6️⃣ označení invite jako přijaté
      await tx.schoolInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
        },
      });

      return {
        schoolId: invite.schoolId,
      };
    });

    // 🔁 znovu načteme usera
const updatedUser = await prisma.user.findUnique({
  where: { id: user.id },
});

// 🔐 nový JWT (KRITICKÉ: schoolId + role)
const newToken = jwt.sign(
  {
    id: updatedUser.id,
    email: updatedUser.email,
    role: updatedUser.role,
    schoolId: updatedUser.schoolId ?? null,
  },
  JWT_SECRET,
  { expiresIn: "7d" }
);

// 🍪 nastavíme cookie
setAuthCookie(res, newToken);

return res.json({
  ok: true,
  user: {
    id: updatedUser.id,
    email: updatedUser.email,
    role: updatedUser.role,
    schoolId: updatedUser.schoolId,
  },
});


  } catch (err) {
    console.error("ACCEPT INVITE ERROR:", err);

    if (err?.status) {
      return res.status(err.status).json({ error: err.error });
    }

    return res.status(500).json({ error: "ACCEPT_INVITE_FAILED" });
  }
});


export default router;
