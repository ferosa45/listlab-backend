// api/src/services/subscriptionService.js
import { PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";



/**
 * Safe wrapper – opravuje chybu P1017 (Server has closed the connection).
 */
async function safeQuery(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === "P1017") {
      console.warn("Prisma lost connection (P1017) → retrying...");
      return await fn();
    }
    throw err;
  }
}

/**
 * Vrátí aktivní subscription pro uživatele nebo školu.
 * Pokud user.schoolId existuje → používá školní subscription.
 */
export async function getActiveSubscriptionForUserOrSchool(user) {
  const ownerType = user.schoolId ? "SCHOOL" : "USER";
  const ownerId = user.schoolId || user.id;

  const now = new Date();

  return await safeQuery(() =>
    prisma.subscription.findFirst({
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
  );
}
