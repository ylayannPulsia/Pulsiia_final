-- Phase 2 — Communication module (Channel + Message)
-- CDC v1.0 §7.5

-- ─── Enum ─────────────────────────────────────────────────────────────────────

CREATE TYPE "ChannelKind" AS ENUM ('ANNOUNCEMENT', 'TEAM', 'CUSTOM');

-- ─── 19. Channel ──────────────────────────────────────────────────────────────

CREATE TABLE "Channel" (
    "id"          TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "kind"        "ChannelKind" NOT NULL DEFAULT 'TEAM',
    "slug"        TEXT NOT NULL,
    "isArchived"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Channel_companyId_slug_key" ON "Channel"("companyId", "slug");
CREATE INDEX "Channel_companyId_idx" ON "Channel"("companyId");

ALTER TABLE "Channel" ADD CONSTRAINT "Channel_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 20. Message ──────────────────────────────────────────────────────────────

CREATE TABLE "Message" (
    "id"        TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId"  TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    "parentId"  TEXT,
    "isPinned"  BOOLEAN NOT NULL DEFAULT false,
    "editedAt"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Message_channelId_idx" ON "Message"("channelId");
CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
