-- Phase 1 — Pulsiia initial schema (18 models)
-- CDC v1.0 §10.2

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "UserRole" AS ENUM ('COLLABORATEUR', 'MANAGER', 'RH', 'DRH', 'ADMIN');
CREATE TYPE "Sector" AS ENUM ('HCR', 'SANTE', 'RETAIL', 'AUTRE');
CREATE TYPE "AuthMode" AS ENUM ('PASSWORD', 'SSO_GOOGLE', 'SSO_MICROSOFT', 'SSO_OKTA');
CREATE TYPE "ShiftType" AS ENUM ('MATIN', 'APRES_MIDI', 'NUIT', 'JOURNEE', 'REPOS');
CREATE TYPE "AbsenceType" AS ENUM ('CP', 'RTT', 'MALADIE', 'MATERNITE', 'PATERNITE', 'ENFANT_MALADE', 'CONGE_SANS_SOLDE', 'FORMATION', 'ACCIDENT_TRAVAIL', 'EVENEMENT_FAMILIAL', 'AUTRE');
CREATE TYPE "AbsenceStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "PayVariableKind" AS ENUM ('HEURES_SUPP', 'PRIME', 'ABSENCE', 'CONGE', 'AVANTAGE_NATURE', 'AUTRE');
CREATE TYPE "PayVariableStatus" AS ENUM ('PENDING', 'VALIDATED', 'ANOMALY', 'REJECTED');
CREATE TYPE "SurveyStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');
CREATE TYPE "DeletionStatus" AS ENUM ('PENDING', 'SCHEDULED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "ConsentKind" AS ENUM ('CGU', 'PRIVACY', 'COOKIES', 'MARKETING');
CREATE TYPE "SSOProvider" AS ENUM ('GOOGLE', 'MICROSOFT', 'OKTA');

-- ─── 1. Company ───────────────────────────────────────────────────────────────

CREATE TABLE "Company" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "sector"      "Sector" NOT NULL DEFAULT 'HCR',
    "ccn"         TEXT,
    "headcount"   INTEGER NOT NULL DEFAULT 0,
    "authMode"    "AuthMode" NOT NULL DEFAULT 'PASSWORD',
    "emailDomain" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");
CREATE UNIQUE INDEX "Company_emailDomain_key" ON "Company"("emailDomain");

-- ─── 2. Site ──────────────────────────────────────────────────────────────────

CREATE TABLE "Site" (
    "id"        TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "city"      TEXT,
    "address"   TEXT,
    "isHQ"      BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Site_companyId_idx" ON "Site"("companyId");

-- ─── 3. User ──────────────────────────────────────────────────────────────────

CREATE TABLE "User" (
    "id"                   TEXT NOT NULL,
    "companyId"            TEXT NOT NULL,
    "primarySiteId"        TEXT,
    "email"                TEXT NOT NULL,
    "passwordHash"         TEXT,
    "firstName"            TEXT NOT NULL,
    "lastName"             TEXT NOT NULL,
    "phone"                TEXT,
    "role"                 "UserRole" NOT NULL DEFAULT 'COLLABORATEUR',
    "isActive"             BOOLEAN NOT NULL DEFAULT true,
    "jobTitle"             TEXT,
    "resetTokenHash"       TEXT,
    "resetTokenExpiresAt"  TIMESTAMP(3),
    "totpSecret"           TEXT,
    "totpEnabled"          BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt"          TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_companyId_idx" ON "User"("companyId");
CREATE INDEX "User_primarySiteId_idx" ON "User"("primarySiteId");
CREATE INDEX "User_role_idx" ON "User"("role");

-- ─── 4. Shift ─────────────────────────────────────────────────────────────────

CREATE TABLE "Shift" (
    "id"          TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "siteId"      TEXT NOT NULL,
    "startsAt"    TIMESTAMP(3) NOT NULL,
    "endsAt"      TIMESTAMP(3) NOT NULL,
    "type"        "ShiftType" NOT NULL DEFAULT 'JOURNEE',
    "notes"       TEXT,
    "hoursWorked" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Shift_companyId_idx" ON "Shift"("companyId");
CREATE INDEX "Shift_userId_idx" ON "Shift"("userId");
CREATE INDEX "Shift_siteId_idx" ON "Shift"("siteId");
CREATE INDEX "Shift_startsAt_idx" ON "Shift"("startsAt");

-- ─── 5. Absence ───────────────────────────────────────────────────────────────

CREATE TABLE "Absence" (
    "id"                   TEXT NOT NULL,
    "companyId"            TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "siteId"               TEXT,
    "type"                 "AbsenceType" NOT NULL,
    "status"               "AbsenceStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt"             TIMESTAMP(3) NOT NULL,
    "endsAt"               TIMESTAMP(3) NOT NULL,
    "reason"               TEXT,
    "rejectReason"         TEXT,
    "validatedById"        TEXT,
    "validatedAt"          TIMESTAMP(3),
    "justificationFileId"  TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Absence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Absence_companyId_idx" ON "Absence"("companyId");
CREATE INDEX "Absence_userId_idx" ON "Absence"("userId");
CREATE INDEX "Absence_status_idx" ON "Absence"("status");
CREATE INDEX "Absence_startsAt_idx" ON "Absence"("startsAt");

-- ─── 6. PayVariable ───────────────────────────────────────────────────────────

CREATE TABLE "PayVariable" (
    "id"              TEXT NOT NULL,
    "companyId"       TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "kind"            "PayVariableKind" NOT NULL,
    "periodYear"      INTEGER NOT NULL,
    "periodMonth"     INTEGER NOT NULL,
    "amount"          DECIMAL(10,2) NOT NULL,
    "unit"            TEXT,
    "status"          "PayVariableStatus" NOT NULL DEFAULT 'PENDING',
    "anomalyReason"   TEXT,
    "validatedById"   TEXT,
    "validatedAt"     TIMESTAMP(3),
    "rejectReason"    TEXT,
    "metadata"        JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayVariable_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayVariable_companyId_idx" ON "PayVariable"("companyId");
CREATE INDEX "PayVariable_userId_idx" ON "PayVariable"("userId");
CREATE INDEX "PayVariable_status_idx" ON "PayVariable"("status");
CREATE INDEX "PayVariable_periodYear_periodMonth_idx" ON "PayVariable"("periodYear", "periodMonth");

-- ─── 7. Survey ────────────────────────────────────────────────────────────────

CREATE TABLE "Survey" (
    "id"        TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "status"    "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt"  TIMESTAMP(3),
    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Survey_companyId_idx" ON "Survey"("companyId");
CREATE INDEX "Survey_status_idx" ON "Survey"("status");
CREATE INDEX "Survey_weekStart_idx" ON "Survey"("weekStart");

-- ─── 8. Question ──────────────────────────────────────────────────────────────

CREATE TABLE "Question" (
    "id"        TEXT NOT NULL,
    "surveyId"  TEXT NOT NULL,
    "position"  INTEGER NOT NULL,
    "prompt"    TEXT NOT NULL,
    "choices"   JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Question_surveyId_position_key" ON "Question"("surveyId", "position");
CREATE INDEX "Question_surveyId_idx" ON "Question"("surveyId");

-- ─── 9. SurveyResponse ────────────────────────────────────────────────────────

CREATE TABLE "SurveyResponse" (
    "id"          TEXT NOT NULL,
    "surveyId"    TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score"       DECIMAL(3,2) NOT NULL,
    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurveyResponse_surveyId_userId_key" ON "SurveyResponse"("surveyId", "userId");
CREATE INDEX "SurveyResponse_surveyId_idx" ON "SurveyResponse"("surveyId");
CREATE INDEX "SurveyResponse_userId_idx" ON "SurveyResponse"("userId");

-- ─── 10. Answer ───────────────────────────────────────────────────────────────

CREATE TABLE "Answer" (
    "id"         TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "value"      INTEGER NOT NULL,
    "comment"    TEXT,
    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Answer_responseId_questionId_key" ON "Answer"("responseId", "questionId");
CREATE INDEX "Answer_responseId_idx" ON "Answer"("responseId");
CREATE INDEX "Answer_questionId_idx" ON "Answer"("questionId");

-- ─── 11. RefreshToken ─────────────────────────────────────────────────────────

CREATE TABLE "RefreshToken" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- ─── 12. PushSubscription ─────────────────────────────────────────────────────

CREATE TABLE "PushSubscription" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "endpoint"  TEXT NOT NULL,
    "p256dh"    TEXT NOT NULL,
    "authKey"   TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- ─── 13. ConsentLog ───────────────────────────────────────────────────────────

CREATE TABLE "ConsentLog" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "kind"      "ConsentKind" NOT NULL,
    "granted"   BOOLEAN NOT NULL,
    "version"   TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsentLog_userId_idx" ON "ConsentLog"("userId");
CREATE INDEX "ConsentLog_kind_idx" ON "ConsentLog"("kind");

-- ─── 14. DataExportRequest ────────────────────────────────────────────────────

CREATE TABLE "DataExportRequest" (
    "id"                TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    "requestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"       TIMESTAMP(3),
    "downloadUrl"       TEXT,
    "downloadExpiresAt" TIMESTAMP(3),
    CONSTRAINT "DataExportRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataExportRequest_userId_idx" ON "DataExportRequest"("userId");

-- ─── 15. DeletionRequest ──────────────────────────────────────────────────────

CREATE TABLE "DeletionRequest" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "status"       "DeletionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "completedAt"  TIMESTAMP(3),
    "cancelledAt"  TIMESTAMP(3),
    "reason"       TEXT,
    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeletionRequest_userId_idx" ON "DeletionRequest"("userId");
CREATE INDEX "DeletionRequest_status_idx" ON "DeletionRequest"("status");
CREATE INDEX "DeletionRequest_scheduledFor_idx" ON "DeletionRequest"("scheduledFor");

-- ─── 16. AuditLog ─────────────────────────────────────────────────────────────

CREATE TABLE "AuditLog" (
    "id"        TEXT NOT NULL,
    "companyId" TEXT,
    "userId"    TEXT,
    "action"    TEXT NOT NULL,
    "resource"  TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_companyId_idx" ON "AuditLog"("companyId");
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- ─── 17. SSOAccount ───────────────────────────────────────────────────────────

CREATE TABLE "SSOAccount" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "provider"       "SSOProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "email"          TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SSOAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SSOAccount_provider_providerUserId_key" ON "SSOAccount"("provider", "providerUserId");
CREATE INDEX "SSOAccount_userId_idx" ON "SSOAccount"("userId");

-- ─── 18. UploadedFile ─────────────────────────────────────────────────────────

CREATE TABLE "UploadedFile" (
    "id"           TEXT NOT NULL,
    "companyId"    TEXT NOT NULL,
    "uploaderId"   TEXT NOT NULL,
    "category"     TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedPath"   TEXT NOT NULL,
    "mimeType"     TEXT NOT NULL,
    "sizeBytes"    INTEGER NOT NULL,
    "verifiedMime" TEXT,
    "isPrivate"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UploadedFile_companyId_idx" ON "UploadedFile"("companyId");
CREATE INDEX "UploadedFile_uploaderId_idx" ON "UploadedFile"("uploaderId");
CREATE INDEX "UploadedFile_category_idx" ON "UploadedFile"("category");

-- ─── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "Site" ADD CONSTRAINT "Site_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_primarySiteId_fkey"
    FOREIGN KEY ("primarySiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Absence" ADD CONSTRAINT "Absence_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_validatedById_fkey"
    FOREIGN KEY ("validatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_justificationFileId_fkey"
    FOREIGN KEY ("justificationFileId") REFERENCES "UploadedFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayVariable" ADD CONSTRAINT "PayVariable_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayVariable" ADD CONSTRAINT "PayVariable_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayVariable" ADD CONSTRAINT "PayVariable_validatedById_fkey"
    FOREIGN KEY ("validatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Survey" ADD CONSTRAINT "Survey_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Question" ADD CONSTRAINT "Question_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Answer" ADD CONSTRAINT "Answer_responseId_fkey"
    FOREIGN KEY ("responseId") REFERENCES "SurveyResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConsentLog" ADD CONSTRAINT "ConsentLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DataExportRequest" ADD CONSTRAINT "DataExportRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SSOAccount" ADD CONSTRAINT "SSOAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_uploaderId_fkey"
    FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
