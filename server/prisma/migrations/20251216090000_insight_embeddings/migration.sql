-- AlterTable
ALTER TABLE "TweetInsight"
ADD COLUMN     "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingDimensions" INTEGER,
ADD COLUMN     "embeddingTextHash" TEXT,
ADD COLUMN     "embeddedAt" TIMESTAMP(3);
