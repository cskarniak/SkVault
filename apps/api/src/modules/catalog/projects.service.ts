import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@skvault/db';
import type { FcpReport, Verdict } from '@skvault/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { compareLibraries, type LibraryInfo, type Relation } from './relations';

/** Résultat du recoupement des originaux introuvables avec le catalogue des autres disques scannés. */
export interface Resolution {
  checkedAt: string;
  /** originaux introuvables à côté de la bibliothèque (donnée du scan) */
  absent: number;
  /** retrouvés dans le catalogue : même chemin relatif (fiable) ou même nom de fichier (probable) */
  foundExact: number;
  foundName: number;
  stillMissing: number;
  byVolume: { host: string; label: string; count: number }[];
  stillMissingSources: { source: string; count: number }[];
  sample: string[];
}

const tailSuffixes = (target: string) => {
  const parts = target.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  const out: string[] = [];
  for (let k = 0; k <= parts.length - 2; k++) out.push(parts.slice(k).join('/'));
  return out; // du plus long au plus court, au moins 2 niveaux
};
const baseName = (target: string) => (target.split(/[\\/]+/).filter(Boolean).pop() ?? '').toLowerCase();

@Injectable()
export class ProjectsService {
  private readonly log = new Logger(ProjectsService.name);
  constructor(private prisma: PrismaService) {}

  /**
   * Cherche dans le catalogue (volumes « doublons » déjà scannés) les originaux que la bibliothèque réclame et qu'on n'a pas retrouvés
   * à côté d'elle : ils sont peut-être sur un autre disque. Le résultat est mémorisé et ne modifie pas le verdict du scan.
   */
  async crossCheck(projectId: string): Promise<Resolution | null> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    const report = project?.report as unknown as FcpReport | null;
    if (!project || project.kind !== 'fcp_library' || !report) return null;
    const missing = report.missingOriginals ?? [];
    const absent = report.originals?.absent ?? 0;

    let foundExact = 0;
    let foundName = 0;
    const byVolume = new Map<string, { host: string; label: string; count: number }>();
    const stillMissing: string[] = [];

    if (missing.length > 0) {
      const names = [...new Set(missing.map(baseName))];
      const rows = await this.prisma.$queryRaw<{ lname: string; rel: string; label: string; host: string }[]>(Prisma.sql`
        SELECT lower(f.name) AS lname, lower(f.rel_path) AS rel, v.label, h.name AS host
        FROM file_entries f JOIN volumes v ON v.id = f.volume_id JOIN hosts h ON h.id = v.host_id
        WHERE lower(f.name) = ANY(${names}::text[]) AND v.id <> ${project.volumeId}`);
      const byName = new Map<string, typeof rows>();
      for (const r of rows) (byName.get(r.lname) ?? byName.set(r.lname, []).get(r.lname)!).push(r);

      for (const target of missing) {
        const candidates = byName.get(baseName(target));
        if (!candidates?.length) { stillMissing.push(target); continue; }
        const suffixes = tailSuffixes(target);
        const exact = candidates.find((c) => suffixes.some((s) => c.rel === s || c.rel.endsWith('/' + s)));
        const hit = exact ?? candidates[0]!;
        if (exact) foundExact++; else foundName++;
        const k = `${hit.host}\u0000${hit.label}`;
        const v = byVolume.get(k) ?? { host: hit.host, label: hit.label, count: 0 };
        v.count++;
        byVolume.set(k, v);
      }
    }
    // La liste des cibles est plafonnée à l'inspection : ce qui dépasse le plafond reste « non vérifié » (compté comme manquant).
    const unverified = Math.max(0, absent - missing.length);
    const sources = new Map<string, number>();
    for (const t of stillMissing) {
      const parts = t.split(/[\\/]+/).filter(Boolean);
      const src = /^[A-Za-z]:/.test(t) ? parts.slice(0, 2).join('\\') : '/' + parts.slice(0, /^\/(Volumes|Users|media|mnt|home)\//.test(t) ? 2 : 1).join('/');
      sources.set(src, (sources.get(src) ?? 0) + 1);
    }
    const resolution: Resolution = {
      checkedAt: new Date().toISOString(),
      absent,
      foundExact,
      foundName,
      stillMissing: stillMissing.length + unverified,
      byVolume: [...byVolume.values()].sort((a, b) => b.count - a.count),
      stillMissingSources: [...sources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      sample: stillMissing.slice(0, 30),
    };
    await this.prisma.project.update({
      where: { id: projectId },
      data: { resolution: resolution as unknown as Prisma.InputJsonValue, resolvedAt: new Date() },
    });
    return resolution;
  }

  /** Recoupe tous les projets Final Cut ayant des originaux introuvables (après un scan, ou à la demande). */
  async recheckAll(): Promise<number> {
    const projects = await this.prisma.project.findMany({ where: { kind: 'fcp_library' }, select: { id: true, report: true } });
    let n = 0;
    for (const p of projects) {
      if (((p.report as unknown as FcpReport | null)?.originals?.absent ?? 0) === 0) continue;
      try { await this.crossCheck(p.id); n++; } catch (e) { this.log.warn(`recoupement impossible (${p.id}) : ${(e as Error).message}`); }
    }
    return n;
  }

  /**
   * Verdict ajusté : une bibliothèque jugée « incomplète » UNIQUEMENT parce que des originaux sont introuvables à côté d'elle passe en
   * « à vérifier » si le catalogue les retrouve tous sur d'autres disques (le projet est alors dispersé, pas perdu).
   */
  effectiveVerdict(verdict: string | null, report: FcpReport | null, resolution: Resolution | null): Verdict | null {
    if (verdict !== 'incomplete' || !report || !resolution) return verdict as Verdict | null;
    const onlyOriginals = report.warnings.filter((w) => w.level === 'error').every((w) => w.code === 'originals_absent');
    return onlyOriginals && resolution.stillMissing === 0 ? 'to_check' : 'incomplete';
  }

  private async libraries(): Promise<(LibraryInfo & { name: string; relPath: string; volume: { label: string; host: string }; verdict: string | null })[]> {
    const rows = await this.prisma.project.findMany({
      where: { kind: 'fcp_library' },
      include: { volume: { select: { label: true, host: { select: { name: true } } } } },
    });
    return rows.map((r) => {
      const rep = r.report as unknown as FcpReport | null;
      return {
        id: r.id, volumeId: r.volumeId, name: r.name, relPath: r.relPath, verdict: r.verdict,
        projectFolder: rep?.projectFolder ?? null, lastEditMs: rep?.lastEditMs ?? null,
        keys: new Set(rep?.mediaKeys ?? []), volume: { label: r.volume.label, host: r.volume.host.name },
      };
    });
  }

  /** Bibliothèques liées à un projet : réplique, version contenue, recoupement ou complément. */
  async relationsOf(projectId: string) {
    const all = await this.libraries();
    const me = all.find((l) => l.id === projectId);
    if (!me) return [];
    return all
      .filter((o) => o.id !== projectId)
      .map((o) => ({ other: o, rel: compareLibraries(me, o) }))
      .filter((x): x is { other: (typeof all)[number]; rel: Relation } => x.rel !== null)
      .map(({ other, rel }) => ({
        projectId: other.id, name: other.name, relPath: other.relPath, volume: other.volume, verdict: other.verdict,
        kind: rel.kind, inter: rel.inter, coverMe: rel.coverA, coverOther: rel.coverB, jaccard: rel.jaccard,
        /** 'me' contient l'autre / 'other' contient moi (pour kind = contained) */
        container: rel.container === undefined ? undefined : rel.container === 'a' ? 'me' : 'other',
        newer: rel.newer === null ? null : rel.newer === 'a' ? 'me' : 'other',
        lastEditMs: other.lastEditMs, sameFolder: rel.sameFolder,
      }))
      .sort((x, y) => y.jaccard - x.jaccard);
  }

  /** Toutes les paires de bibliothèques liées (vue « Relations »). */
  async allRelations() {
    const all = await this.libraries();
    const out: {
      a: { id: string; name: string; volume: string; lastEditMs: number | null; keys: number };
      b: { id: string; name: string; volume: string; lastEditMs: number | null; keys: number };
      kind: string; container?: 'a' | 'b'; newer: 'a' | 'b' | null; inter: number; coverA: number; coverB: number; sameFolder: boolean;
    }[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const rel = compareLibraries(all[i]!, all[j]!);
        if (!rel) continue;
        const brief = (l: (typeof all)[number]) => ({ id: l.id, name: l.name, volume: `${l.volume.host} · ${l.volume.label}`, lastEditMs: l.lastEditMs, keys: l.keys.size });
        out.push({ a: brief(all[i]!), b: brief(all[j]!), kind: rel.kind, container: rel.container, newer: rel.newer, inter: rel.inter, coverA: rel.coverA, coverB: rel.coverB, sameFolder: rel.sameFolder });
      }
    }
    return out;
  }
}
