-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "resolution" JSONB,
ADD COLUMN     "resolved_at" TIMESTAMP(3);

-- Recoupement des originaux de projets avec le catalogue : recherche par nom de fichier insensible à la casse
CREATE INDEX "file_entries_lower_name_idx" ON "file_entries" (lower("name"));
