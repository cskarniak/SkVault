-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "os" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volumes" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "root_path" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "total_bytes" BIGINT,
    "free_bytes" BIGINT,
    "last_scan_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_runs" (
    "id" TEXT NOT NULL,
    "volume_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "files_seen" INTEGER NOT NULL DEFAULT 0,
    "files_removed" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_entries" (
    "id" BIGSERIAL NOT NULL,
    "volume_id" TEXT NOT NULL,
    "rel_path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mtime" TIMESTAMP(3) NOT NULL,
    "quick_hash" TEXT,
    "hash" TEXT,
    "last_scan_id" TEXT,

    CONSTRAINT "file_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "hosts_name_key" ON "hosts"("name");

-- CreateIndex
CREATE UNIQUE INDEX "volumes_host_id_root_path_key" ON "volumes"("host_id", "root_path");

-- CreateIndex
CREATE INDEX "file_entries_size_quick_hash_idx" ON "file_entries"("size", "quick_hash");

-- CreateIndex
CREATE INDEX "file_entries_hash_idx" ON "file_entries"("hash");

-- CreateIndex
CREATE INDEX "file_entries_name_idx" ON "file_entries"("name");

-- CreateIndex
CREATE UNIQUE INDEX "file_entries_volume_id_rel_path_key" ON "file_entries"("volume_id", "rel_path");

-- AddForeignKey
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_volume_id_fkey" FOREIGN KEY ("volume_id") REFERENCES "volumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_entries" ADD CONSTRAINT "file_entries_volume_id_fkey" FOREIGN KEY ("volume_id") REFERENCES "volumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
