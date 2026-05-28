-- AlterTable
ALTER TABLE "User" ADD COLUMN "contractEndDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Skill_companyId_idx" ON "Skill"("companyId");
CREATE UNIQUE INDEX "Skill_companyId_name_key" ON "Skill"("companyId", "name");

ALTER TABLE "Skill" ADD CONSTRAINT "Skill_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
