/*
  Warnings:

  - A unique constraint covering the columns `[stripeSubscriptionId]` on the table `School` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "School" ADD COLUMN     "seatLimit" INTEGER,
ADD COLUMN     "stripeSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "School_stripeSubscriptionId_key" ON "School"("stripeSubscriptionId");
