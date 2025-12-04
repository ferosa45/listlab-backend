// api/src/middleware/licenseContext.js
import { getActiveSubscriptionForUserOrSchool } from "../services/subscriptionService.js";

export async function licenseContext(req, res, next) {
  try {
    const user = req.user;

    const subscription = await getActiveSubscriptionForUserOrSchool(user);

    // ✅ Nový model: používáme planCode (ne plan_code)
    const planCode = subscription?.planCode ?? "FREE";

    // --- OWNER LOGIKA ---
    let ownerType = "USER";
    let ownerId = user.id;

    // Pokud je uživatel ve škole:
    if (user.schoolId) {
      ownerType = "SCHOOL";
      ownerId = user.schoolId;
    }

    req.license = {
      ownerType,
      ownerId,
      planCode,
      subscription,
    };

    next();
  } catch (err) {
    console.error("licenseContext ERROR:", err);
    return res.status(500).json({ ok: false, error: "License resolution failed" });
  }
}
