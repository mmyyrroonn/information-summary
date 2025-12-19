-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED');

-- AlterTable
ALTER TABLE "Subscription"
ADD COLUMN     "status" "SubscriptionStatus" NOT NULL DEFAULT 'SUBSCRIBED',
ADD COLUMN     "unsubscribedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Subscription_status_lastFetchedAt_idx" ON "Subscription"("status", "lastFetchedAt");

