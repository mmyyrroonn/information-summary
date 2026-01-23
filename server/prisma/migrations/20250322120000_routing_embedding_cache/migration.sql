-- CreateTable
CREATE TABLE "RoutingEmbeddingCache" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "positives" JSONB NOT NULL,
    "negatives" JSONB NOT NULL,
    "positiveCount" INTEGER NOT NULL,
    "negativeCount" INTEGER NOT NULL,
    "sourceWindowDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingEmbeddingCache_pkey" PRIMARY KEY ("id")
);
