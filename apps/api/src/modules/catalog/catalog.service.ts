import { Injectable } from '@nestjs/common';
import { Prisma } from '@skvault/db';
import { PrismaService } from '../../prisma/prisma.service';

const PAGE_SIZE = 50;
/** Clé d'identité d'un fichier : SHA-256 complet, à défaut MD5 hérité de l'ancien index (jamais mélangés). */
const DUP_KEY = Prisma.sql`COALESCE(hash, 'md5:' || md5)`;

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
    return {
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
        files: bigint; bytes: bigint | null;
      }[]
    >`
      SELECT v.id, v.label, v.root_path, v.kind, h.name AS host, v.last_scan_at, v.total_bytes, v.free_bytes,
             count(f.id) AS files, sum(f.size) AS bytes
      FROM volumes v JOIN hosts h ON h.id = v.host_id
      LEFT JOIN file_entries f ON f.volume_id = v.id
      GROUP BY v.id, h.name ORDER BY h.name, v.label`;
    return rows.map((r) => ({
      id: r.id, label: r.label, rootPath: r.root_path, kind: r.kind, host: r.host,
      lastScanAt: r.last_scan_at, totalBytes: r.total_bytes, freeBytes: r.free_bytes,
      files: Number(r.files), bytes: Number(r.bytes ?? 0),
    }));
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
