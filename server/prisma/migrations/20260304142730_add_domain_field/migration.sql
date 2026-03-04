-- AlterTable
ALTER TABLE "ReportProfile" ADD COLUMN     "domains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Tweet" ADD COLUMN     "routingDomain" TEXT;

-- AlterTable
ALTER TABLE "TweetInsight" ADD COLUMN     "domain" TEXT;
