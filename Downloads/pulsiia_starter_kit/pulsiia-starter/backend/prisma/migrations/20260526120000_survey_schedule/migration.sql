-- AlterTable
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "durationDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "endsAt" TIMESTAMP(3);
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "onlyOnWorkShifts" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Survey"
SET "endsAt" = "weekStart" + (("durationDays" - 1) * INTERVAL '1 day') + INTERVAL '23 hours 59 minutes 59 seconds'
WHERE "endsAt" IS NULL;
