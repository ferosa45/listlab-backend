// server/middleware/licenseContext.js

import { getActiveSubscriptionForUserOrSchool } from "../services/subscriptionService.js";
import { ENTITLEMENTS } from "../config/entitlements.js";

/**
 * Middleware, který:
 * - zjistí aktivní subscription (nebo FREE)
 * - načte entitlements (práva)
 * - uloží do req.license
 */
export async function licenseContext(req, res, next) {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // 1) načteme subscription
    const subscription = await getActiveSubscriptionForUserOrSchool(user);

    // 2) určíme planCode
    const planCode = subscription?.plan_code || "FREE";

    // 3) načteme práva z tabulky ENTITLEMENTS
    const entitlements = ENTITLEMENTS[planCode];

    if (!entitlements) {
      console.error("Neznámý planCode:", planCode);
      return res.status(500).json({ message: `Unknown plan: ${planCode}` });
    }

    // 4) uložíme licence info do requestu
    req.license = {
      planCode,
      entitlements,
      subscription
    };

    next();
  } catch (e) {
    console.error("licenseContext error:", e);
    res.status(500).json({ message: "Failed to load license context" });
  }
}
