import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@skvault/db';
import type { FcpReport } from '@skvault/shared';
import { PrismaService } from '../../prisma/prisma.service';

const PAGE_SIZE = 50;
/** Clé d'identité d'un fichier : SHA-256 complet, à défaut MD5 hérité de l'ancien index (jamais mélangés). */
const DUP_KEY = Prisma.sql`COALESCE(hash, 'md5:' || md5)`;

/** Octets récupérables d'un projet, par nature (jamais les médias originaux). */
function reclaimable(report: FcpReport | null) {
  const c = report?.categories;
  return {
    useless: c?.cache_temp.bytes ?? 0,
    regenerable: (c?.render_files.bytes ?? 0) + (c?.analysis_files.bytes ?? 0),
    conditional: c?.transcoded_media.bytes ?? 0,
  };
}

@Injectable()
export class CatalogService {
  constructor(private prisma: PrismaService) {}

  async overview() {
    const [totals] = await this.prisma.$queryRaw<{ files: bigint; bytes: bigint | null }[]>`
      SELECT count(*) AS files, sum(size) AS bytes FROM file_entries`;
    const [dups] = await this.prisma.$queryRaw<{ groups: bigint; wasted: bigint | null }[]>`
      SELECT count(*) AS groups, sum(wasted) AS wasted FROM (
        SELECT (count(*) - 1) * size AS wasted FROM file_entries
        WHERE ${DUP_KEY} IS NOT NULL GROUP BY size, ${DUP_KEY} HAVING count(*) > 1) d`;
    const projects = await this.prisma.project.count();
    return {
      projects,
      files: Number(totals?.files ?? 0),
      bytes: Number(totals?.bytes ?? 0),
      duplicateGroups: Number(dups?.groups ?? 0),
      wastedBytes: Number(dups?.wasted ?? 0),
    };
  }

  async volumes() {
    const rows = await this.prisma.$queryRaw<
      {
        id: string; label: string; root_path: string; kind: string; host: string;
        last_scan_at: Date | null; total_bytes: bigint | null; free_bytes: bigint | null;
        scan_mode: string; note: string | null; physical_location: string | null;
        files: bigint; bytes: bigint | null; projects: bigint;
      }[]
    >`
      SELECT v.id, v.label, v.root_path, v.kind, h.name AS host, v.last_scan_at, v.total_bytes, v.free_bytes,
             v.scan_mode, v.note, v.physical_location,
             (SELECT count(*) FROM file_entries f WHERE f.volume_id = v.id) AS files,
             (SELECT sum(f.size) FROM file_entries f WHERE f.volume_id = v.id) AS bytes,
             (SELECT count(*) FROM projects p WHERE p.volume_id = v.id) AS projects
      FROM volumes v JOIN hosts h ON h.id = v.host_id
      ORDER BY h.name, v.label`;
    return rows.map((r) => ({
      id: r.id, label: r.label, rootPath: r.root_path, kind: r.kind, host: r.host,
      lastScanAt: r.last_scan_at, totalBytes: r.total_bytes, freeBytes: r.free_bytes,
      scanMode: r.scan_mode, note: r.note, physicalLocation: r.physical_location,
      files: Number(r.files), bytes: Number(r.bytes ?? 0), projects: Number(r.projects),
    }));
  }

  /** Note libre et emplacement physique d'un disque. */
  async patchVolume(id: string, dto: { note?: string | null; physicalLocation?: string | null }) {
    const data: Prisma.VolumeUpdateInput = {};
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.physicalLocation !== undefined) data.physicalLocation = dto.physicalLocation?.trim() || null;
    const v = await this.prisma.volume.update({ where: { id }, data });
    return { id: v.id, note: v.note, physicalLocation: v.physicalLocation };
  }

  /**
   * Projets (bibliothèques Final Cut, photothèques). Pour chaque projet : espace récupérable par nature, calculé depuis le
   * rapport — inutile (caches…), régénérable (rendus, analyses), conditionnel (transcodés, si les originaux sont présents).
   */
  async projects(p: { q?: string; volumeId?: string; verdict?: string; kind?: string; page: number }) {
    const where: Prisma.ProjectWhereInput = {};
    if (p.q) where.OR = [{ name: { contains: p.q, mode: 'insensitive' } }, { relPath: { contains: p.q, mode: 'insensitive' } }];
    if (p.volumeId) where.volumeId = p.volumeId;
    if (p.verdict) where.verdict = p.verdict;
    if (p.kind) where.kind = p.kind;
    const [total, rows] = await Promise.all([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where, orderBy: [{ volume: { host: { name: 'asc' } } }, { name: 'asc' }], skip: (p.page - 1) * PAGE_SIZE, take: PAGE_SIZE,
        include: { volume: { select: { id: true, label: true, physicalLocation: true, host: { select: { name: true } } } } },
      }),
    ]);
    return {
      total, page: p.page, pageSize: PAGE_SIZE,
      items: rows.map((r) => ({
        id: r.id, kind: r.kind, name: r.name, relPath: r.relPath, size: r.size, fileCount: r.fileCount, mtime: r.mtime,
        verdict: r.verdict, updatedAt: r.updatedAt,
        volume: { id: r.volume.id, label: r.volume.label, host: r.volume.host.name, physicalLocation: r.volume.physicalLocation },
        reclaimable: reclaimable(r.report as unknown as FcpReport | null),
        warnings: ((r.report as unknown as FcpReport | null)?.warnings ?? []).filter((w) => w.level !== 'info').length,
      })),
    };
  }

  async project(id: string) {
    const r = await this.prisma.project.findUnique({
      where: { id },
      include: { volume: { select: { id: true, label: true, rootPath: true, physicalLocation: true, host: { select: { name: true } } } } },
    });
    if (!r) throw new NotFoundException('Projet introuvable');
    return {
      id: r.id, kind: r.kind, name: r.name, relPath: r.relPath, size: r.size, fileCount: r.fileCount, mtime: r.mtime,
      verdict: r.verdict, updatedAt: r.updatedAt, report: r.report as unknown as FcpReport | null,
      volume: { id: r.volume.id, label: r.volume.label, rootPath: r.volume.rootPath, host: r.volume.host.name, physicalLocation: r.volume.physicalLocation },
    };
  }

  /** Retire un volume du catalogue (n'efface rien sur le disque). */
  async removeVolume(id: string) {
    await this.prisma.volume.delete({ where: { id } });
    return { ok: true };
  }

  async search(p: { q?: string; ext?: string; volumeId?: string; minSize?: number; page: number }) {
    const where: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (p.q) where.push(Prisma.sql`f.rel_path ILIKE ${'%' + p.q.replace(/[%_\\]/g, '\\$&') + '%'}`);
    if (p.ext) where.push(Prisma.sql`f.ext = ${p.ext.toLowerCase().replace('.', '')}`);
    if (p.volumeId) where.push(Prisma.sql`f.volume_id = ${p.volumeId}`);
    if (p.minSize) where.push(Prisma.sql`f.size >= ${p.minSize}`);
    const cond = Prisma.join(where, ' AND ');

    const [items, [count]] = await Promise.all([
      this.prisma.$queryRaw<
        { id: bigint; rel_path: string; size: bigint; mtime: Date; hash: string | null; volume: string; host: string }[]
      >`SELECT f.id, f.rel_path, f.size, f.mtime, f.hash, v.label AS volume, h.name AS host
        FROM file_entries f JOIN volumes v ON v.id = f.volume_id JOIN hosts h ON h.id = v.host_id
        WHERE ${cond} ORDER BY f.rel_path LIMIT ${PAGE_SIZE} OFFSET ${(p.page - 1) * PAGE_SIZE}`,
      this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM file_entries f WHERE ${cond}`,
    ]);
    return {
      total: Number(count?.n ?? 0), page: p.page, pageSize: PAGE_SIZE,
      items: items.map((i) => ({
        id: i.id, relPath: i.rel_path, size: i.size, mtime: i.mtime, hashed: !!i.hash, volume: i.volume, host: i.host,
      })),
    };
  }

  /** Groupes de fichiers identiques (même taille + SHA-256 complet), les plus coûteux d'abord. */
  async duplicates(minSize: number, page: number) {
    const groups = await this.prisma.$queryRaw<{ hash: string; size: bigint; copies: bigint }[]>`
      SELECT ${DUP_KEY} AS hash, size, count(*) AS copies FROM file_entries
      WHERE ${DUP_KEY} IS NOT NULL AND size >= ${minSize}
      GROUP BY size, ${DUP_KEY} HAVING count(*) > 1
      ORDER BY (count(*) - 1) * size DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
    if (groups.length === 0) return { page, pageSize: PAGE_SIZE, groups: [] };

    const files = await this.prisma.$queryRaw<
      { hash: string; rel_path: string; volume: string; host: string }[]
    >`SELECT COALESCE(f.hash, 'md5:' || f.md5) AS hash, f.rel_path, v.label AS volume, h.name AS host
      FROM file_entries f JOIN volumes v ON v.id = f.volume_id JOIN hosts h ON h.id = v.host_id
      WHERE COALESCE(f.hash, 'md5:' || f.md5) IN (${Prisma.join(groups.map((g) => g.hash))})
      ORDER BY h.name, v.label, f.rel_path`;

    return {
      page, pageSize: PAGE_SIZE,
      groups: groups.map((g) => ({
        hash: g.hash, size: g.size, copies: Number(g.copies),
        wastedBytes: Number(g.size) * (Number(g.copies) - 1),
        files: files.filter((f) => f.hash === g.hash).map((f) => ({ relPath: f.rel_path, volume: f.volume, host: f.host })),
      })),
    };
  }
}
