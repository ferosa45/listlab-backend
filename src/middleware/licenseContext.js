// api/src/middleware/licenseContext.js
import { prisma } from "../db/prisma.js";
import { getActiveSubscriptionForUserOrSchool } from "../services/subscriptionService.js";

export async function licenseContext(req, res, next) {
  try {
    const user = req.user;

    let ownerType = "USER";
    let ownerId = user.id;
    let planCode = "FREE";
    let subscription = null;

    // --------------------------------------------------
    // 🏫 UŽIVATEL JE VE ŠKOLE → LICENCE JE ZE ŠKOLY
    // --------------------------------------------------
    if (user.schoolId) {
      ownerType = "SCHOOL";
      ownerId = user.schoolId;

      const school = await prisma.school.findUnique({
        where: { id: user.schoolId },
        select: {
          subscriptionPlan: true,
          subscriptionStatus: true,
        },
      });

      // 🔥 KLÍČOVÉ: bereme plán přímo ze školy
      if (school?.subscriptionPlan) {
        planCode = school.subscriptionPlan;
      }

      // subscription je jen doplňková informace
      subscription = await getActiveSubscriptionForUserOrSchool(user);
    } 
    // --------------------------------------------------
    // 👤 INDIVIDUÁLNÍ UŽIVATEL
    // --------------------------------------------------
    else {
      subscription = await getActiveSubscriptionForUserOrSchool(user);
      planCode = subscription?.planCode ?? "FREE";
    }

    req.license = {
      ownerType,
      ownerId,
      planCode,
      subscription,
    };

    // 🧪 dočasný debug – klidně pak smaž
    console.log("🔐 LICENSE CONTEXT:", req.license);

    next();
  } catch (err) {
    console.error("licenseContext ERROR:", err);
    return res
      .status(500)
      .json({ ok: false, error: "License resolution failed" });
  }
}
