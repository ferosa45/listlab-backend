// src/services/usageService.js
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

/**
 * Vrátí nebo vytvoří usage record pro daného ownera (user nebo school)
 */
export async function getOrCreateUsageRecord(ownerType, ownerId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let usage = await prisma.usageLimit.findFirst({
    where: { ownerType, ownerId, year, month }
  });

  if (!usage) {
    usage = await prisma.usageLimit.create({
      data: {
        ownerType,
        ownerId,
        year,
        month
      }
    });
  }

  return usage;
}

/**
 * Zvýší počet worksheetů o 1
 */
export async function incrementWorksheetUsage(ownerType, ownerId) {
  const usage = await getOrCreateUsageRecord(ownerType, ownerId);

  return prisma.usageLimit.update({
    where: { id: usage.id },
    data: {
      worksheetsCount: usage.worksheetsCount + 1,
      updatedAt: new Date()
    }
  });
}

/**
 * Přidá AI generaci (1x denně pro FREE)
 */
export async function incrementAiUsage(ownerType, ownerId) {
  const usage = await getOrCreateUsageRecord(ownerType, ownerId);

  return prisma.usageLimit.update({
    where: { id: usage.id },
    data: {
      aiGenerations: usage.aiGenerations + 1,
      updatedAt: new Date()
    }
  });
}
