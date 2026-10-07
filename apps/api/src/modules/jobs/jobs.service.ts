import { BadRequestException, ConflictException, GatewayTimeoutException, Injectable, NotFoundException } from '@nestjs/common';
import { SCAN_MODE_LABELS, type BrowseResult, type CreateScanJobDto, type ScanMode } from '@skvault/shared';
import { Prisma } from '@skvault/db';
import { PrismaService } from '../../prisma/prisma.service';

const ONLINE_MS = 30_000;
const BROWSE_WAIT_MS = 15_000;     // attente de la réponse de l'agent côté web
const BROWSE_LONGPOLL_MS = 20_000; // attente d'une demande côté agent (réponse quasi instantanée)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Identity { hostName: string; os?: string }
interface Progress { phase: 'listing' | 'hashing' | 'inspecting'; filesSeen: number; scanId?: string }
interface Finish { status: 'done' | 'failed' | 'cancelled'; message?: string; filesSeen?: number }

@Injectable()
export class JobsService {
  constructor(private prisma: PrismaService) {}

  // ── Côté web ───────────────────────────────────────────────────────────────

  async hosts() {
    const hosts = await this.prisma.host.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { volumes: true } } },
    });
    const now = Date.now();
    return hosts.map((h) => ({
      id: h.id, name: h.name, os: h.os, lastSeenAt: h.lastSeenAt, volumes: h._count.volumes,
      online: !!h.lastSeenAt && now - h.lastSeenAt.getTime() < ONLINE_MS,
    }));
  }

  list(limit: number) {
    return this.prisma.scanJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { host: { select: { name: true } } },
    });
  }

  async enqueue(dto: CreateScanJobDto) {
    const host = await this.prisma.host.findUnique({ where: { id: dto.hostId } });
    if (!host) throw new NotFoundException('Machine inconnue');
    const active = await this.prisma.scanJob.findFirst({
      where: { hostId: dto.hostId, rootPath: dto.rootPath, status: { in: ['queued', 'running'] } },
    });
    if (active) throw new ConflictException('Un scan de ce chemin est déjà en attente ou en cours');

    // Le type d'un volume est fixé : en changer exige une confirmation explicite (les données de l'ancien type seront supprimées).
    const volume = await this.prisma.volume.findUnique({
      where: { hostId_rootPath: { hostId: dto.hostId, rootPath: dto.rootPath } },
    });
    if (volume && volume.scanMode !== dto.mode && !dto.confirmModeChange) {
      const [files, projects] = await Promise.all([
        this.prisma.fileEntry.count({ where: { volumeId: volume.id } }),
        this.prisma.project.count({ where: { volumeId: volume.id } }),
      ]);
      throw new ConflictException({
        statusCode: 409, error: 'Conflict', code: 'MODE_CHANGE', files, projects,
        message: `Ce volume est de type « ${SCAN_MODE_LABELS[volume.scanMode as ScanMode]} ». Le passer en « ${SCAN_MODE_LABELS[dto.mode]} » supprimera ses données actuelles : ${files.toLocaleString('fr-FR')} fichier(s) catalogué(s), ${projects} projet(s).`,
      });
    }
    return this.prisma.scanJob.create({
      data: {
        hostId: dto.hostId, rootPath: dto.rootPath, label: dto.label, kind: dto.kind,
        mode: dto.mode, confirmModeChange: !!dto.confirmModeChange,
      },
    });
  }

  /** « Rescanner » : réutilise le type enregistré du volume, sans rien redemander. */
  async rescan(volumeId: string) {
    const v = await this.prisma.volume.findUnique({ where: { id: volumeId } });
    if (!v) throw new NotFoundException('Volume inconnu');
    return this.enqueue({
      hostId: v.hostId, rootPath: v.rootPath, label: v.label, kind: v.kind as CreateScanJobDto['kind'], mode: v.scanMode as ScanMode,
    });
  }

  async cancel(id: string) {
    const job = await this.prisma.scanJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException();
    if (job.status === 'queued') {
      return this.prisma.scanJob.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date() } });
    }
    if (job.status === 'running') {
      // L'agent voit la demande à sa prochaine remontée de progression.
      return this.prisma.scanJob.update({ where: { id }, data: { cancelRequested: true } });
    }
    throw new BadRequestException('Ce scan est déjà terminé');
  }

  /** Sélecteur de dossier : pose une demande à l'agent de la machine et attend sa réponse (quelques secondes). */
  async browse(hostId: string, path: string | undefined): Promise<BrowseResult> {
    const host = await this.prisma.host.findUnique({ where: { id: hostId } });
    if (!host) throw new NotFoundException('Machine inconnue');
    if (!host.lastSeenAt || Date.now() - host.lastSeenAt.getTime() > ONLINE_MS) {
      throw new ConflictException('Cet agent est hors ligne : impossible de parcourir ses dossiers');
    }
    await this.prisma.browseRequest.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
    const req = await this.prisma.browseRequest.create({ data: { hostId, path: path || null } });

    const deadline = Date.now() + BROWSE_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(250);
      const r = await this.prisma.browseRequest.findUnique({ where: { id: req.id } });
      if (r?.status === 'done' || r?.status === 'error') {
        await this.prisma.browseRequest.deleteMany({ where: { id: req.id } }); // éphémère : consommée, on la supprime
        if (r.status === 'error') throw new BadRequestException(r.error ?? 'Dossier illisible');
        return r.result as unknown as BrowseResult;
      }
    }
    await this.prisma.browseRequest.deleteMany({ where: { id: req.id } });
    throw new GatewayTimeoutException(
      'L\'agent n\'a pas répondu. S\'il a été installé avant cette fonction, mettez-le à jour en relançant sa commande d\'installation.',
    );
  }

  // ── Côté agent ─────────────────────────────────────────────────────────────

  private touchHost({ hostName, os }: Identity) {
    return this.prisma.host.upsert({
      where: { name: hostName },
      create: { name: hostName, os, lastSeenAt: new Date() },
      update: { os, lastSeenAt: new Date() },
    });
  }

  /** Démarrage du démon : les jobs « running » de cette machine sont orphelins (agent redémarré). */
  async agentHello(identity: Identity) {
    const host = await this.touchHost(identity);
    const orphans = await this.prisma.scanJob.updateMany({
      where: { hostId: host.id, status: 'running' },
      data: { status: 'failed', message: 'Agent redémarré pendant le scan', finishedAt: new Date() },
    });
    return { hostId: host.id, orphansFailed: orphans.count };
  }

  async agentHeartbeat(identity: Identity) {
    await this.touchHost(identity);
    return { ok: true };
  }

  /** Réserve atomiquement le plus ancien job en attente de cette machine. */
  async agentPoll(identity: Identity) {
    const host = await this.touchHost(identity);
    const rows = await this.prisma.$queryRaw<
      { id: string; root_path: string; label: string; kind: string; mode: string; confirm_mode_change: boolean }[]
    >`
      UPDATE scan_jobs SET status = 'running', started_at = now(), phase = NULL, files_seen = 0
      WHERE id = (SELECT id FROM scan_jobs WHERE host_id = ${host.id} AND status = 'queued'
                  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, root_path, label, kind, mode, confirm_mode_change`;
    const j = rows[0];
    return {
      job: j ? { id: j.id, rootPath: j.root_path, label: j.label, kind: j.kind, mode: j.mode, confirmModeChange: j.confirm_mode_change } : null,
    };
  }

  async agentProgress(id: string, p: Progress) {
    const job = await this.getRunning(id);
    await this.prisma.scanJob.update({
      where: { id },
      data: { phase: p.phase, filesSeen: p.filesSeen, ...(p.scanId ? { scanRunId: p.scanId } : {}) },
    });
    await this.prisma.host.update({ where: { id: job.hostId }, data: { lastSeenAt: new Date() } });
    return { cancel: job.cancelRequested };
  }

  async agentFinish(id: string, f: Finish) {
    const job = await this.getRunning(id);
    if (f.status !== 'done' && job.scanRunId) {
      // Scan interrompu : on ne le laisse pas « en cours » (et rien n'est purgé du catalogue).
      await this.prisma.scanRun.updateMany({
        where: { id: job.scanRunId, status: 'running' },
        data: { status: 'failed', finishedAt: new Date() },
      });
    }
    await this.prisma.scanJob.update({
      where: { id },
      data: {
        status: f.status, message: f.message, finishedAt: new Date(),
        ...(f.filesSeen !== undefined ? { filesSeen: f.filesSeen } : {}),
      },
    });
    return { ok: true };
  }

  private async getRunning(id: string) {
    const job = await this.prisma.scanJob.findUnique({ where: { id } });
    if (!job || job.status !== 'running') throw new NotFoundException('Job introuvable ou terminé');
    return job;
  }

  /** Long-poll : attend jusqu'à 20 s qu'une demande de navigation arrive pour cette machine (réponse instantanée). */
  async agentBrowsePoll(identity: Identity) {
    const host = await this.touchHost(identity);
    const deadline = Date.now() + BROWSE_LONGPOLL_MS;
    do {
      const rows = await this.prisma.$queryRaw<{ id: string; path: string | null }[]>(Prisma.sql`
        UPDATE browse_requests SET status = 'working'
        WHERE id = (SELECT id FROM browse_requests WHERE host_id = ${host.id} AND status = 'pending'
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, path`);
      if (rows[0]) return { request: { id: rows[0].id, path: rows[0].path } };
      await sleep(400);
    } while (Date.now() < deadline);
    return { request: null };
  }

  async agentBrowseResult(id: string, body: { ok: true; path: string; parent: string | null; entries: { name: string; path: string }[]; truncated: boolean } | { ok: false; error: string }) {
    const req = await this.prisma.browseRequest.findUnique({ where: { id } });
    if (!req || req.status !== 'working') throw new NotFoundException('Demande introuvable ou expirée');
    await this.prisma.browseRequest.update({
      where: { id },
      data: body.ok
        ? { status: 'done', result: { path: body.path, parent: body.parent, entries: body.entries, truncated: body.truncated } }
        : { status: 'error', error: body.error },
    });
    return { ok: true };
  }
}
