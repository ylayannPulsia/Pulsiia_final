-- Feuilles d'heures — génération PDF + signature Yousign
CREATE TABLE "TimesheetSheet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "reference" TEXT,
    "storedName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'BROUILLON',
    "generatedBy" TEXT,
    "generatedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signatureProvider" TEXT,
    "signatureRequestId" TEXT,
    "signatureSignerId" TEXT,
    "signatureStatus" TEXT,
    "signatureLink" TEXT,
    "signatureLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimesheetSheet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TimesheetSheet_companyId_userId_period_key" ON "TimesheetSheet"("companyId", "userId", "period");
CREATE INDEX "TimesheetSheet_companyId_period_status_idx" ON "TimesheetSheet"("companyId", "period", "status");
CREATE INDEX "TimesheetSheet_signatureRequestId_idx" ON "TimesheetSheet"("signatureRequestId");

ALTER TABLE "TimesheetSheet" ADD CONSTRAINT "TimesheetSheet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimesheetSheet" ADD CONSTRAINT "TimesheetSheet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
