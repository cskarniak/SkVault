import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@skvault/db';
import type { PushHashesDto, ScanFileDto, StartScanDto } from '@skvault/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { extname } from 'path';

@Injectable()
export class IngestService {
  constructor(private prisma: PrismaService) {}

  async start(dto: StartScanDto) {
    const host = await this.prisma.host.upsert({
      where: { name: dto.hostName },
      create: { name: dto.hostName, os: dto.os },
      update: { os: dto.os },
    });
    const v = dto.volume;
    const volume = await this.prisma.volume.upsert({
      where: { hostId_rootPath: { hostId: host.id, rootPath: v.rootPath } },
      create: {
        hostId: host.id, label: v.label, rootPath: v.rootPath, kind: v.kind,
        totalBytes: v.totalBytes, freeBytes: v.freeBytes,
      },
      update: { label: v.label, kind: v.kind, totalBytes: v.totalBytes, freeBytes: v.freeBytes },
    });
    const scan = await this.prisma.scanRun.create({ data: { volumeId: volume.id } });
    return { scanId: scan.id, volumeId: volume.id };
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

  /** Supprime du catalogue les fichiers non revus par ce scan (effacés ou déplacés sur le disque). */
  async finish(scanId: string) {
    const scan = await this.getRunningScan(scanId);
    const removed = await this.prisma.$executeRaw`
      DELETE FROM file_entries WHERE volume_id = ${scan.volumeId} AND last_scan_id IS DISTINCT FROM ${scanId}`;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.scanRun.update({
        where: { id: scanId },
        data: { status: 'done', finishedAt: now, filesRemoved: removed },
      }),
      this.prisma.volume.update({ where: { id: scan.volumeId }, data: { lastScanAt: now } }),
    ]);
    return { filesSeen: scan.filesSeen, filesRemoved: removed };
  }

  private async getRunningScan(id: string) {
    const scan = await this.prisma.scanRun.findUnique({ where: { id } });
    if (!scan || scan.status !== 'running') throw new NotFoundException('Scan introuvable ou terminé');
    return scan;
  }
}
