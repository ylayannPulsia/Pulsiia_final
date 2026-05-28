-- CreateTable
CREATE TABLE "JobPosition" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalPole" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalPole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobPosition_companyId_idx" ON "JobPosition"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "JobPosition_companyId_name_key" ON "JobPosition"("companyId", "name");

-- CreateIndex
CREATE INDEX "OperationalPole_companyId_idx" ON "OperationalPole"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalPole_companyId_name_key" ON "OperationalPole"("companyId", "name");

-- AddForeignKey
ALTER TABLE "JobPosition" ADD CONSTRAINT "JobPosition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalPole" ADD CONSTRAINT "OperationalPole_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
