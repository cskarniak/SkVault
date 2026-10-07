import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@skvault/db';
import { SCAN_MODE_LABELS, type ProjectDto, type PushHashesDto, type ScanFileDto, type ScanMode, type StartScanDto } from '@skvault/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../catalog/projects.service';
import { extname } from 'path';

@Injectable()
export class IngestService {
  constructor(private prisma: PrismaService, private projects: ProjectsService) {}

  /**
   * Démarre un scan. Le type de scan est FIXÉ par volume : sans `mode` on suit celui du volume (« duplicates » pour un
   * nouveau volume) ; avec un autre `mode`, il faut `allowModeChange` (confirmé par l'utilisateur) et les données de
   * l'ancien type sont supprimées — jamais de mélange sur un même volume.
   */
  async start(dto: StartScanDto) {
    const host = await this.prisma.host.upsert({
      where: { name: dto.hostName },
      create: { name: dto.hostName, os: dto.os },
      update: { os: dto.os },
    });
    const v = dto.volume;
    const existing = await this.prisma.volume.findUnique({
      where: { hostId_rootPath: { hostId: host.id, rootPath: v.rootPath } },
    });

    let mode: ScanMode = (existing?.scanMode as ScanMode | undefined) ?? dto.mode ?? 'duplicates';
    if (existing && dto.mode && dto.mode !== existing.scanMode) {
      if (!dto.allowModeChange) {
        const [files, projects] = await Promise.all([
          this.prisma.fileEntry.count({ where: { volumeId: existing.id } }),
          this.prisma.project.count({ where: { volumeId: existing.id } }),
        ]);
        throw new ConflictException({
          statusCode: 409, error: 'Conflict', code: 'MODE_CHANGE', files, projects,
          message: `Ce volume est de type « ${SCAN_MODE_LABELS[existing.scanMode as ScanMode]} » : le passer en « ${SCAN_MODE_LABELS[dto.mode]} » supprimera ses données actuelles (${files} fichier(s), ${projects} projet(s)).`,
        });
      }
      mode = dto.mode;
      await this.purgeForMode(existing.id, mode);
    }

    const volume = await this.prisma.volume.upsert({
      where: { hostId_rootPath: { hostId: host.id, rootPath: v.rootPath } },
      create: {
        hostId: host.id, label: v.label, rootPath: v.rootPath, kind: v.kind, scanMode: mode,
        totalBytes: v.totalBytes, freeBytes: v.freeBytes,
      },
      update: { label: v.label, kind: v.kind, scanMode: mode, totalBytes: v.totalBytes, freeBytes: v.freeBytes },
    });
    const scan = await this.prisma.scanRun.create({ data: { volumeId: volume.id, mode } });
    return { scanId: scan.id, volumeId: volume.id, mode };
  }

  /** Supprime les données de l'AUTRE type : fichiers + photothèques (vers « archive »), bibliothèques Final Cut (vers « doublons »). */
  private async purgeForMode(volumeId: string, newMode: ScanMode) {
    if (newMode === 'fcp_archive') {
      await this.prisma.fileEntry.deleteMany({ where: { volumeId } });
      await this.prisma.project.deleteMany({ where: { volumeId, kind: 'photo_library' } });
    } else {
      await this.prisma.project.deleteMany({ where: { volumeId, kind: 'fcp_library' } });
    }
  }

  /** Enregistre des projets (bibliothèques Final Cut inspectées, photothèques repérées) : upsert par (volume, chemin). */
  async pushProjects(scanId: string, projects: ProjectDto[]) {
    const scan = await this.getRunningScan(scanId);
    for (const p of projects) {
      const data = {
        kind: p.kind, name: p.name, size: p.size !== undefined ? BigInt(Math.round(p.size)) : null,
        fileCount: p.fileCount ?? null, mtime: p.mtime ? new Date(p.mtime) : null, verdict: p.verdict ?? null,
        report: (p.report ?? undefined) as Prisma.InputJsonValue | undefined, lastScanId: scanId,
      };
      await this.prisma.project.upsert({
        where: { volumeId_relPath: { volumeId: scan.volumeId, relPath: p.relPath } },
        create: { volumeId: scan.volumeId, relPath: p.relPath, ...data },
        update: data,
      });
    }
    await this.prisma.scanRun.update({ where: { id: scanId }, data: { filesSeen: { increment: projects.length } } });
    return { received: projects.length };
  }

  /** Upsert par lot. Hash complet invalidé si la taille ou la date a changé. */
  async pushFiles(scanId: string, files: ScanFileDto[]) {
    const scan = await this.getRunningScan(scanId);
    if (files.length === 0) return { received: 0 };

    const relPaths = files.map((f) => f.relPath);
    const names = files.map((f) => f.relPath.split('/').pop() ?? f.relPath);
    const exts = files.map((f) => extname(f.relPath).toLowerCase().replace('.', ''));
    const sizes = files.map((f) => String(f.size));
    const mtimes = files.map((f) => f.mtime);
    const quick = files.map((f) => f.quickHash ?? '');
    const md5s = files.map((f) => f.md5 ?? '');

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO file_entries (volume_id, rel_path, name, ext, size, mtime, quick_hash, md5, last_scan_id)
      SELECT ${scan.volumeId}, t.rel_path, t.name, t.ext, t.size::bigint, t.mtime::timestamptz,
             NULLIF(t.quick_hash, ''), NULLIF(t.md5, ''), ${scanId}
      FROM unnest(${relPaths}::text[], ${names}::text[], ${exts}::text[], ${sizes}::text[],
                  ${mtimes}::text[], ${quick}::text[], ${md5s}::text[])
        AS t(rel_path, name, ext, size, mtime, quick_hash, md5)
      ON CONFLICT (volume_id, rel_path) DO UPDATE SET
        hash = CASE WHEN file_entries.size = EXCLUDED.size AND file_entries.mtime = EXCLUDED.mtime
                    THEN file_entries.hash ELSE NULL END,
        md5 = CASE WHEN file_entries.size = EXCLUDED.size AND file_entries.mtime = EXCLUDED.mtime
                   THEN COALESCE(EXCLUDED.md5, file_entries.md5) ELSE EXCLUDED.md5 END,
        quick_hash = EXCLUDED.quick_hash,
        name = EXCLUDED.name, ext = EXCLUDED.ext,
        size = EXCLUDED.size, mtime = EXCLUDED.mtime,
        last_scan_id = EXCLUDED.last_scan_id`);

    await this.prisma.scanRun.update({
      where: { id: scanId },
      data: { filesSeen: { increment: files.length } },
    });
    return { received: files.length };
  }

  /** Fichiers du volume sans hash complet mais ayant un homonyme (taille + quickHash) ailleurs dans le catalogue. */
  async pendingHashes(scanId: string) {
    const scan = await this.getRunningScan(scanId);
    const rows = await this.prisma.$queryRaw<{ rel_path: string }[]>`
      SELECT f.rel_path FROM file_entries f
      WHERE f.volume_id = ${scan.volumeId} AND f.hash IS NULL
        AND f.last_scan_id = ${scanId} AND f.quick_hash IS NOT NULL AND f.size > 0
        AND EXISTS (SELECT 1 FROM file_entries o
                    WHERE o.size = f.size AND o.quick_hash = f.quick_hash AND o.id <> f.id)
      LIMIT 5000`;
    return { relPaths: rows.map((r) => r.rel_path) };
  }

  async pushHashes(scanId: string, hashes: PushHashesDto['hashes']) {
    const scan = await this.getRunningScan(scanId);
    if (hashes.length === 0) return { updated: 0 };
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE file_entries f SET hash = t.hash
      FROM unnest(${hashes.map((h) => h.relPath)}::text[], ${hashes.map((h) => h.hash)}::text[]) AS t(rel_path, hash)
      WHERE f.volume_id = ${scan.volumeId} AND f.rel_path = t.rel_path`);
    return { updated };
  }

  /**
   * Termine le scan : retire du catalogue ce qui n'a pas été revu (effacé/déplacé sur le disque).
   * « doublons » : fichiers + photothèques ; « archive » : projets uniquement.
   */
  async finish(scanId: string) {
    const scan = await this.getRunningScan(scanId);
    let removed = 0;
    if (scan.mode === 'fcp_archive') {
      removed = (await this.prisma.project.deleteMany({
        where: { volumeId: scan.volumeId, OR: [{ lastScanId: null }, { lastScanId: { not: scanId } }] },
      })).count;
    } else {
      removed = await this.prisma.$executeRaw`
        DELETE FROM file_entries WHERE volume_id = ${scan.volumeId} AND last_scan_id IS DISTINCT FROM ${scanId}`;
      await this.prisma.project.deleteMany({
        where: { volumeId: scan.volumeId, kind: 'photo_library', OR: [{ lastScanId: null }, { lastScanId: { not: scanId } }] },
      });
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.scanRun.update({
        where: { id: scanId },
        data: { status: 'done', finishedAt: now, filesRemoved: removed },
      }),
      this.prisma.volume.update({ where: { id: scan.volumeId }, data: { lastScanAt: now } }),
    ]);
    // Le catalogue vient de changer : on recoupe les originaux de projets avec lui (sans bloquer la fin du scan).
    void this.projects.recheckAll().catch(() => undefined);
    return { filesSeen: scan.filesSeen, filesRemoved: removed };
  }

  private async getRunningScan(id: string) {
    const scan = await this.prisma.scanRun.findUnique({ where: { id } });
    if (!scan || scan.status !== 'running') throw new NotFoundException('Scan introuvable ou terminé');
    return scan;
  }
}
