import express from "express";
import crypto from "crypto";
import { prisma } from "../src/lib/prisma.js";

const router = express.Router();

/**
 * POST /api/schools/:id/invites
 * vytvoření pozvánky pro učitele
 */
router.post("/schools/:id/invites", async (req, res) => {
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

export default router;
