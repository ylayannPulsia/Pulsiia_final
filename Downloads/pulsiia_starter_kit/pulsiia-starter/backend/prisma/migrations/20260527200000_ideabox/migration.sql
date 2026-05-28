-- Migration: Boîte à idées anonyme

-- CreateTable IdeaBoxPost
CREATE TABLE IF NOT EXISTS "IdeaBoxPost" (
    "id"        TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "anonAlias" TEXT NOT NULL,
    "text"      TEXT NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'VISIBLE',
    "weekKey"   TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdeaBoxPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable IdeaBoxReaction
CREATE TABLE IF NOT EXISTS "IdeaBoxReaction" (
    "id"        TEXT NOT NULL,
    "postId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "emoji"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdeaBoxReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IdeaBoxPost_companyId_createdAt_idx" ON "IdeaBoxPost"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "IdeaBoxPost_userId_weekKey_idx"       ON "IdeaBoxPost"("userId", "weekKey");
CREATE UNIQUE INDEX IF NOT EXISTS "IdeaBoxReaction_postId_userId_emoji_key" ON "IdeaBoxReaction"("postId", "userId", "emoji");
CREATE INDEX IF NOT EXISTS "IdeaBoxReaction_postId_idx"           ON "IdeaBoxReaction"("postId");

-- AddForeignKey
ALTER TABLE "IdeaBoxPost" ADD CONSTRAINT "IdeaBoxPost_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdeaBoxReaction" ADD CONSTRAINT "IdeaBoxReaction_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "IdeaBoxPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdeaBoxReaction" ADD CONSTRAINT "IdeaBoxReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
