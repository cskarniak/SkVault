-- AlterTable
ALTER TABLE "scan_jobs" ADD COLUMN     "confirm_mode_change" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'duplicates';

-- AlterTable
ALTER TABLE "scan_runs" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'duplicates';

-- AlterTable
ALTER TABLE "volumes" ADD COLUMN     "note" TEXT,
ADD COLUMN     "physical_location" TEXT,
ADD COLUMN     "scan_mode" TEXT NOT NULL DEFAULT 'duplicates';

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "volume_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rel_path" TEXT NOT NULL,
    "size" BIGINT,
    "file_count" INTEGER,
    "mtime" TIMESTAMP(3),
    "verdict" TEXT,
    "report" JSONB,
    "last_scan_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_name_idx" ON "projects"("name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_volume_id_rel_path_key" ON "projects"("volume_id", "rel_path");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_volume_id_fkey" FOREIGN KEY ("volume_id") REFERENCES "volumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
