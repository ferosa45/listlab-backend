-- AlterTable
ALTER TABLE "User" ADD COLUMN     "billingCity" TEXT,
ADD COLUMN     "billingCountry" TEXT DEFAULT 'CZ',
ADD COLUMN     "billingDic" TEXT,
ADD COLUMN     "billingIco" TEXT,
ADD COLUMN     "billingName" TEXT,
ADD COLUMN     "billingStreet" TEXT,
ADD COLUMN     "billingZip" TEXT;
