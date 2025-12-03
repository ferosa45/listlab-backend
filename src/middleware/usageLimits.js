// src/middleware/usageLimits.js
import { getOrCreateUsageRecord } from "../services/usageService.js";

export async function checkWorksheetLimit(req, res, next) {
  const license = req.license;

  // PRO / SCHOOL = unlimited
  if (license.planCode !== "FREE") return next();

  const ownerType = license.ownerType;   // "user" nebo "school"
  const ownerId = license.ownerId;

  const usage = await getOrCreateUsageRecord(ownerType, ownerId);
  const used = usage.worksheetsCount;
  const allowed = 3; // FREE

  if (used >= allowed) {
    return res.status(429).json({
      ok: false,
      error: "WORKSHEET_LIMIT_REACHED",
      message: "Vyčerpali jste měsíční limit 3 pracovních listů.",
      used,
      allowed
    });
  }

  next();
}

export async function checkAiLimit(req, res, next) {
  const license = req.license;

  // PRO / SCHOOL = unlimited
  if (license.planCode !== "FREE") return next();

  const ownerType = license.ownerType;
  const ownerId = license.ownerId;

  const usage = await getOrCreateUsageRecord(ownerType, ownerId);
  const used = usage.aiGenerations;

  // AI = jen 1× denně pro FREE
  const allowedPerDay = 1;

  // zjistit dnešní datum (pouze den, bez času)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const updated = new Date(usage.updatedAt);
  updated.setHours(0, 0, 0, 0);

  const alreadyUsedToday = updated.getTime() === today.getTime();

  if (alreadyUsedToday && used >= allowedPerDay) {
    return res.status(429).json({
      ok: false,
      error: "AI_LIMIT_REACHED",
      message: "Dnes jste již vyčerpali limit 1 AI generace.",
      used: 1,
      allowed: 1
    });
  }

  next();
}
