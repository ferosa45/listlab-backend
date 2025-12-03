/*
  Warnings:

  - You are about to drop the column `maxTeachers` on the `School` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionValidUntil` on the `School` table. All the data in the column will be lost.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `Invite` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Worksheet` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_schoolId_fkey";

-- DropForeignKey
ALTER TABLE "Worksheet" DROP CONSTRAINT "Worksheet_schoolId_fkey";

-- DropForeignKey
ALTER TABLE "Worksheet" DROP CONSTRAINT "Worksheet_userId_fkey";

-- AlterTable
ALTER TABLE "School" DROP COLUMN "maxTeachers",
DROP COLUMN "subscriptionValidUntil";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'TEACHER';

-- DropTable
DROP TABLE "Invite";

-- DropTable
DROP TABLE "Worksheet";

-- DropEnum
DROP TYPE "Role";

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorksheetLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorksheetLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "License_schoolId_key" ON "License"("schoolId");

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorksheetLog" ADD CONSTRAINT "WorksheetLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
