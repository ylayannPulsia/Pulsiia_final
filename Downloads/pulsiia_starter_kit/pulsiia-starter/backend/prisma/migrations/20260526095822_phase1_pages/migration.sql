-- AlterTable
ALTER TABLE "UploadedFile" ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "CommChannel" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommChannel_companyId_idx" ON "CommChannel"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CommChannel_companyId_slug_key" ON "CommChannel"("companyId", "slug");

-- CreateIndex
CREATE INDEX "CommMessage_channelId_createdAt_idx" ON "CommMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "CommMessage_userId_idx" ON "CommMessage"("userId");

-- AddForeignKey
ALTER TABLE "CommMessage" ADD CONSTRAINT "CommMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "CommChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommMessage" ADD CONSTRAINT "CommMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommMessage" ADD CONSTRAINT "CommMessage_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CommMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
