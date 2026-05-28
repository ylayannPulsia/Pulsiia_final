-- Signature électronique Yousign (eIDAS) + versioning documents
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "rootFileId" TEXT;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "versionNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "isCurrentVersion" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "signatureProvider" TEXT;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "signatureRequestId" TEXT;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "signatureSignerId" TEXT;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "signatureStatus" TEXT;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "signatureLink" TEXT;
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "signatureLevel" TEXT;

CREATE INDEX IF NOT EXISTS "UploadedFile_rootFileId_idx" ON "UploadedFile"("rootFileId");
CREATE INDEX IF NOT EXISTS "UploadedFile_signatureRequestId_idx" ON "UploadedFile"("signatureRequestId");
CREATE INDEX IF NOT EXISTS "UploadedFile_isCurrentVersion_idx" ON "UploadedFile"("isCurrentVersion");
