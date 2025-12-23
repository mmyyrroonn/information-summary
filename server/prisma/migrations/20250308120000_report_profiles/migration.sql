-- Add subscription tags
ALTER TABLE "Subscription" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Add report profile table
CREATE TABLE "ReportProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleCron" TEXT NOT NULL,
    "windowHours" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "includeTweetTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "excludeTweetTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "includeAuthorTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "excludeAuthorTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "minImportance" INTEGER NOT NULL DEFAULT 2,
    "verdicts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "groupBy" TEXT NOT NULL DEFAULT 'cluster',
    "aiFilterEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiFilterPrompt" TEXT,
    "aiFilterMaxKeepPerChunk" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportProfile_pkey" PRIMARY KEY ("id")
);

-- Link reports to profiles
ALTER TABLE "Report" ADD COLUMN "profileId" TEXT;

CREATE INDEX "ReportProfile_enabled_scheduleCron_idx" ON "ReportProfile"("enabled", "scheduleCron");
CREATE INDEX "Report_profileId_idx" ON "Report"("profileId");

ALTER TABLE "Report" ADD CONSTRAINT "Report_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ReportProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
