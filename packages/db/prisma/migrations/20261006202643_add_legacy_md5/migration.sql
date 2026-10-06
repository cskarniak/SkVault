-- AlterTable
ALTER TABLE "file_entries" ADD COLUMN     "md5" TEXT;

-- CreateIndex
CREATE INDEX "file_entries_md5_idx" ON "file_entries"("md5");
