import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { requireAuth } from "../src/middleware/authMiddleware.js";

const router = express.Router();

/**
 * GET /api/invoices
 * Vrátí faktury školy přihlášeného uživatele
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // 🔐 musí patřit ke škole
    if (!user.schoolId) {
      return res.status(403).json({
        ok: false,
        error: "Uživatel nemá přiřazenou školu",
      });
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        schoolId: user.schoolId,
      },
      orderBy: {
        issuedAt: "desc",
      },
      select: {
        id: true,
        number: true,
        issuedAt: true,
        amountPaid: true,
        currency: true,
        status: true,
      },
    });

    res.json({
      ok: true,
      invoices,
    });
  } catch (err) {
    console.error("❌ Failed to load invoices:", err);
    res.status(500).json({
      ok: false,
      error: "Nepodařilo se načíst faktury",
    });
  }
});

export default router;
