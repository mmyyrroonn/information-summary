-- AlterTable
ALTER TABLE "TweetEmbedding"
ADD COLUMN     "summaryEmbedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "summaryModel" TEXT,
ADD COLUMN     "summaryDimensions" INTEGER,
ADD COLUMN     "summaryTextHash" TEXT,
ADD COLUMN     "summaryEmbeddedAt" TIMESTAMP(3);
