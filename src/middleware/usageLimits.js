// src/middleware/usageLimits.js
import { getOrCreateUsageRecord } from "../services/usageService.js";

//
// WORKSHEET LIMIT – FREE = max 3 měsíčně
//
export async function checkWorksheetLimit(req, res, next) {
  const license = req.license;

  if (!license) {
    console.error("❌ licenseContext missing in checkWorksheetLimit");
    return res.status(500).json({ ok: false, error: "License missing" });
  }

  // PRO / SCHOOL = unlimited
  if (license.planCode !== "FREE") return next();

  const ownerType = license.ownerType;  // "user" nebo "school"
  const ownerId = license.ownerId;

  const usage = await getOrCreateUsageRecord(ownerType, ownerId);

  const used = usage?.worksheetsCount ?? 0;
  const allowed = 3; // FREE plan

  if (used >= allowed) {
    return res.status(429).json({
      ok: false,
      error: "WORKSHEET_LIMIT_REACHED",
      message: "Vyčerpali jste měsíční limit 3 pracovních listů.",
      used,
      allowed,
    });
  }

  next();
}

//
// AI LIMIT – FREE = max 1 denně
//
export async function checkAiLimit(req, res, next) {
  const license = req.license;

  if (!license) {
    console.error("❌ licenseContext missing in checkAiLimit");
    return res.status(500).json({ ok: false, error: "License missing" });
  }

  // PRO / SCHOOL = unlimited
  if (license.planCode !== "FREE") return next();

  const ownerType = license.ownerType;
  const ownerId = license.ownerId;

  const usage = await getOrCreateUsageRecord(ownerType, ownerId);

  const usedToday = usage?.aiGenerations ?? 0;
  const allowedPerDay = 1;

  // Normalizace datumu
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const lastUpdate = usage.updatedAt ? new Date(usage.updatedAt) : new Date(0);
  lastUpdate.setHours(0, 0, 0, 0);

  const isSameDay = lastUpdate.getTime() === today.getTime();

  // Pokud už AI generace dnes proběhla
  if (isSameDay && usedToday >= allowedPerDay) {
    return res.status(429).json({
      ok: false,
      error: "AI_LIMIT_REACHED",
      message: "Dnes jste již vyčerpali limit 1 AI generace.",
      used: allowedPerDay,
      allowed: allowedPerDay,
    });
  }

  next();
}
