/*
  Warnings:

  - A unique constraint covering the columns `[passwordSetupToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "School" ADD COLUMN     "billingCity" TEXT,
ADD COLUMN     "billingCountry" TEXT,
ADD COLUMN     "billingDic" TEXT,
ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "billingIco" TEXT,
ADD COLUMN     "billingName" TEXT,
ADD COLUMN     "billingStreet" TEXT,
ADD COLUMN     "billingZip" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordSetupExpires" TIMESTAMP(3),
ADD COLUMN     "passwordSetupToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_passwordSetupToken_key" ON "User"("passwordSetupToken");
