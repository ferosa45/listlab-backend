// src/lib/prisma.js
import { PrismaClient } from "@prisma/client";

// Použijeme globální objekt, aby se v dev prostředí Prisma nevytvářelo opakovaně
const globalForPrisma = globalThis;

// Vytvoříme instanci Prisma s optimalizovaným nastavením pro Railway
export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        // Extra parametry zabraňují tomu, aby Railway shazoval spojení (P1017)
        url: process.env.DATABASE_URL + "?connection_limit=1&pool_timeout=30",
      },
    },
    log: ["warn", "error"], // případně můžeš přidat "query" při debugování
  });

// V developmentu uložíme instanci do globální cache
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
