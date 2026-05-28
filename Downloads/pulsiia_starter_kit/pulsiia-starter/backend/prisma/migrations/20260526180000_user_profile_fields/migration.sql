-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('CDI', 'CDD', 'INTERIM');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "contractType" "ContractType" NOT NULL DEFAULT 'CDI',
ADD COLUMN     "weeklyHours" DOUBLE PRECISION,
ADD COLUMN     "competences" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "secondaryRoles" TEXT[] DEFAULT ARRAY[]::TEXT[];
