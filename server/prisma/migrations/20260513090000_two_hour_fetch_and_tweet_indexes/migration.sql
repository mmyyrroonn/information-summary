ALTER TABLE "SourceList" ALTER COLUMN "scheduleCron" SET DEFAULT '0 */2 * * *';
ALTER TABLE "SourceList" ALTER COLUMN "sourceCooldownHours" SET DEFAULT 2;

UPDATE "SourceList"
SET "scheduleCron" = '0 */2 * * *',
    "sourceCooldownHours" = 2
WHERE "scheduleCron" = '*/15 * * * *'
  AND "sourceCooldownHours" = 6;

CREATE INDEX "Tweet_tweetedAt_idx" ON "Tweet"("tweetedAt");
CREATE INDEX "Tweet_subscriptionId_tweetedAt_idx" ON "Tweet"("subscriptionId", "tweetedAt");
CREATE INDEX "Tweet_routingStatus_tweetedAt_idx" ON "Tweet"("routingStatus", "tweetedAt");
