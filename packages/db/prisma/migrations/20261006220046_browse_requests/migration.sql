-- CreateTable
CREATE TABLE "browse_requests" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browse_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "browse_requests_host_id_status_idx" ON "browse_requests"("host_id", "status");

-- AddForeignKey
ALTER TABLE "browse_requests" ADD CONSTRAINT "browse_requests_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
