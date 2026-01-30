import { getOrCreateUsageRecord } from "../services/usageService.js";

// ==================================================================
// 📄 WORKSHEET LIMIT (Ukládání/Stahování)
// Limit: 5 měsíčně
// ==================================================================
export async function checkWorksheetLimit(req, res, next) {
  const license = req.license;

  if (!license) {
    return res.status(500).json({ ok: false, error: "License missing" });
  }

  // Pokud je placený, pouštíme dál
  if (license.planCode !== "FREE") return next();

  const ownerType = license.ownerType;
  const ownerId = license.ownerId;

  // Načte měsíční záznam
  const usage = await getOrCreateUsageRecord(ownerType, ownerId);
  const used = usage?.worksheetsCount ?? 0;
  
  const allowed = 5; 

  if (used >= allowed) {
    return res.status(429).json({
      ok: false,
      error: "LIMIT_REACHED",
      message: `Vyčerpali jste měsíční limit ${allowed} pracovních listů. Limit se obnoví 1. dne v měsíci.`,
      used,
      allowed,
    });
  }

  next();
}

// ==================================================================
// 🧠 AI LIMIT (Generování)
// Limit: 5 měsíčně
// ==================================================================
export async function checkAiLimit(req, res, next) {
  const license = req.license;

  if (!license) {
    return res.status(500).json({ ok: false, error: "License missing" });
  }

  if (license.planCode !== "FREE") return next();

  const ownerType = license.ownerType;
  const ownerId = license.ownerId;

  // Načte měsíční záznam
  const usage = await getOrCreateUsageRecord(ownerType, ownerId);
  
  // Zde je celkový počet generování za tento měsíc
  const usedMonth = usage?.aiGenerations ?? 0;
  
  const allowedMonth = 5;

  if (usedMonth >= allowedMonth) {
     return res.status(429).json({
       ok: false, 
       error: "LIMIT_REACHED",
       message: `Vyčerpali jste měsíční limit ${allowedMonth} AI generování. Přejděte na PRO pro neomezený přístup.`,
       used: usedMonth,
       allowed: allowedMonth
     });
  }

  next();
}