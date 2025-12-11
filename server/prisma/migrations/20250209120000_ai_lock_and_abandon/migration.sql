-- AlterTable
ALTER TABLE "Tweet" ADD COLUMN     "abandonedAt" TIMESTAMP(3),
ADD COLUMN     "abandonReason" TEXT;

-- CreateTable
CREATE TABLE "SystemLock" (
    "key" TEXT NOT NULL,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLock_pkey" PRIMARY KEY ("key")
);
