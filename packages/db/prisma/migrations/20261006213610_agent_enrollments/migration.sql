-- CreateTable
CREATE TABLE "agent_enrollments" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "host_name" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_enrollments_code_key" ON "agent_enrollments"("code");
