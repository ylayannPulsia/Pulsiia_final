-- CreateTable
CREATE TABLE "WellbeingMeeting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT,
    "teamLabel" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'Point manager bien-être',
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WellbeingMeeting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WellbeingMeeting_companyId_status_idx" ON "WellbeingMeeting"("companyId", "status");
CREATE INDEX "WellbeingMeeting_scheduledAt_idx" ON "WellbeingMeeting"("scheduledAt");

ALTER TABLE "WellbeingMeeting" ADD CONSTRAINT "WellbeingMeeting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WellbeingMeeting" ADD CONSTRAINT "WellbeingMeeting_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
