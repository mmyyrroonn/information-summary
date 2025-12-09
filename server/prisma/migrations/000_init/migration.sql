-- CreateEnum
CREATE TYPE "AiRunKind" AS ENUM ('TWEET_CLASSIFY', 'REPORT_SUMMARY');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "screenName" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastFetchedAt" TIMESTAMP(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tweet" (
    "id" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorScreen" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lang" TEXT,
    "raw" JSONB NOT NULL,
    "tweetedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tweetUrl" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Tweet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TweetInsight" (
    "id" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "summary" TEXT,
    "importance" INTEGER,
    "tags" TEXT[],
    "suggestions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "aiRunId" TEXT,

    CONSTRAINT "TweetInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "kind" "AiRunKind" NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "prompt" TEXT,
    "response" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "headline" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "outline" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "aiRunId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "deliveryTarget" TEXT,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tgBotToken" TEXT,
    "tgChatId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_screenName_key" ON "Subscription"("screenName");

-- CreateIndex
CREATE UNIQUE INDEX "Tweet_tweetId_key" ON "Tweet"("tweetId");

-- CreateIndex
CREATE UNIQUE INDEX "TweetInsight_tweetId_key" ON "TweetInsight"("tweetId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_aiRunId_key" ON "Report"("aiRunId");

-- AddForeignKey
ALTER TABLE "Tweet" ADD CONSTRAINT "Tweet_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TweetInsight" ADD CONSTRAINT "TweetInsight_tweetId_fkey" FOREIGN KEY ("tweetId") REFERENCES "Tweet"("tweetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TweetInsight" ADD CONSTRAINT "TweetInsight_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "AiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "AiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
