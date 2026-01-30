-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_schoolId_fkey";

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "schoolId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;
