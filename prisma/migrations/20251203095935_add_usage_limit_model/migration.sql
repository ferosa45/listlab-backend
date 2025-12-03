-- CreateTable
CREATE TABLE "UsageLimit" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "worksheetsCount" INTEGER NOT NULL DEFAULT 0,
    "aiGenerations" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageLimit_pkey" PRIMARY KEY ("id")
);
