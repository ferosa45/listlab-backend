import { getActiveSubscriptionForUserOrSchool } from "../services/subscriptionService.js";

export async function licenseContext(req, res, next) {
  try {
    const user = req.user;

    const subscription = await getActiveSubscriptionForUserOrSchool(user);

    // Free plan = žádná subscription v DB
    const planCode = subscription?.plan_code ?? "FREE";

    // ENTITLEMENTS se natahuje v serveru – takže jen necháme planCode

    // --- OWNER LOGIKA ---
    let ownerType = "user";
    let ownerId = user.id;

    // Pokud je uživatel ve škole:
    if (user.schoolId) {
      ownerType = "school";
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
