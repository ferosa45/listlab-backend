/*
  Warnings:

  - A unique constraint covering the columns `[stripeInvoiceId]` on the table `Invoice` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `stripeCustomerId` to the `Invoice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `stripeInvoiceId` to the `Invoice` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "stripeCustomerId" TEXT NOT NULL,
ADD COLUMN     "stripeInvoiceId" TEXT NOT NULL,
ADD COLUMN     "stripeSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");
