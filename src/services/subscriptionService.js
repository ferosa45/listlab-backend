// api/src/services/subscriptionService.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Vrátí aktivní subscription pro uživatele nebo školu.
 * Pokud user.schoolId existuje → používá školní subscription.
 *
 * @param {Object} user - uživatel z authMiddleware
 * @returns {Promise<Object|null>}
 */
export async function getActiveSubscriptionForUserOrSchool(user) {
  let ownerType;
  let ownerId;

  if (user.schoolId) {
    ownerType = "school";
    ownerId = user.schoolId;
  } else {
    ownerType = "user";
    ownerId = user.id;
  }

 const subscription = await prisma.subscription.findFirst({
  where: {
    ownerType,
    ownerId,
    isActive: true,
    OR: [
      { validTo: null },
      { validTo: { gt: new Date() } }
    ]
  },
  orderBy: { validFrom: "desc" }
});

  return subscription ?? null;
}
