-- AlterTable
ALTER TABLE "hosts" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "scan_jobs" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "root_path" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "files_seen" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "scan_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "scan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_jobs_host_id_status_idx" ON "scan_jobs"("host_id", "status");

-- AddForeignKey
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
