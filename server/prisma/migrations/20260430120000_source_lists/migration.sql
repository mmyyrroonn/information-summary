-- CreateEnum
CREATE TYPE "SourcePlatform" AS ENUM ('TWITTER', 'YOUTUBE', 'BILIBILI', 'WECHAT');

-- CreateTable
CREATE TABLE "SourceList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleCron" TEXT NOT NULL DEFAULT '*/15 * * * *',
    "batchSize" INTEGER NOT NULL DEFAULT 20,
    "sourceCooldownHours" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "platform" "SourcePlatform" NOT NULL,
    "identifier" TEXT NOT NULL,
    "displayName" TEXT,
    "url" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ReportProfile" ADD COLUMN "sourceListId" TEXT;

-- CreateIndex
CREATE INDEX "SourceList_enabled_scheduleCron_idx" ON "SourceList"("enabled", "scheduleCron");

-- CreateIndex
CREATE UNIQUE INDEX "Source_listId_platform_identifier_key" ON "Source"("listId", "platform", "identifier");

-- CreateIndex
CREATE INDEX "Source_listId_enabled_lastFetchedAt_idx" ON "Source"("listId", "enabled", "lastFetchedAt");

-- CreateIndex
CREATE INDEX "Source_platform_identifier_idx" ON "Source"("platform", "identifier");

-- CreateIndex
CREATE INDEX "Source_subscriptionId_idx" ON "Source"("subscriptionId");

-- CreateIndex
CREATE INDEX "ReportProfile_sourceListId_idx" ON "ReportProfile"("sourceListId");

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_listId_fkey" FOREIGN KEY ("listId") REFERENCES "SourceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportProfile" ADD CONSTRAINT "ReportProfile_sourceListId_fkey" FOREIGN KEY ("sourceListId") REFERENCES "SourceList"("id") ON DELETE SET NULL ON UPDATE CASCADE;
