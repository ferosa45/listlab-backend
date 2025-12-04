// api/src/services/subscriptionService.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Vrátí aktivní subscription pro uživatele nebo školu.
 * Pokud user.schoolId existuje → používá školní subscription.
 */
export async function getActiveSubscriptionForUserOrSchool(user) {

  const ownerType = user.schoolId ? "SCHOOL" : "USER"
  const ownerId = user.schoolId || user.id

  const now = new Date()

  const subscription = await prisma.subscription.findFirst({
    where: {
      ownerType,
      ownerId,
      status: { in: ["active", "trialing"] },
      currentPeriodEnd: { gt: now }
    },
    orderBy: {
      currentPeriodEnd: "desc"
    }
  })

  return subscription ?? null
}
