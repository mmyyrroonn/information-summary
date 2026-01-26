-- CreateTable
CREATE TABLE "TweetEmbedding" (
    "id" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "textHash" TEXT NOT NULL,
    "embeddedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TweetEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TweetEmbedding_tweetId_key" ON "TweetEmbedding"("tweetId");

-- AddForeignKey
ALTER TABLE "TweetEmbedding" ADD CONSTRAINT "TweetEmbedding_tweetId_fkey" FOREIGN KEY ("tweetId") REFERENCES "Tweet"("tweetId") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "RoutingTagEmbeddingCache" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "tagSamples" JSONB NOT NULL,
    "tagSampleCounts" JSONB NOT NULL,
    "samplePerTag" INTEGER NOT NULL,
    "sourceWindowDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingTagEmbeddingCache_pkey" PRIMARY KEY ("id")
);
