-- Add routing metadata to support decoupled classification.
CREATE TYPE "RoutingStatus" AS ENUM ('PENDING', 'IGNORED', 'AUTO_HIGH', 'ROUTED', 'LLM_QUEUED');

ALTER TABLE "Tweet"
  ADD COLUMN "routingStatus" "RoutingStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "routingTag" TEXT,
  ADD COLUMN "routingScore" DOUBLE PRECISION,
  ADD COLUMN "routingMargin" DOUBLE PRECISION,
  ADD COLUMN "routingReason" TEXT,
  ADD COLUMN "routedAt" TIMESTAMP(3),
  ADD COLUMN "llmQueuedAt" TIMESTAMP(3);

CREATE INDEX "Tweet_routingStatus_routingTag_idx" ON "Tweet"("routingStatus", "routingTag");
CREATE INDEX "Tweet_routingStatus_llmQueuedAt_idx" ON "Tweet"("routingStatus", "llmQueuedAt");
