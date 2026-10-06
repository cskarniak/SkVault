import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateScanJobDto } from '@skvault/shared';
import { PrismaService } from '../../prisma/prisma.service';

const ONLINE_MS = 30_000;

interface Identity { hostName: string; os?: string }
interface Progress { phase: 'listing' | 'hashing'; filesSeen: number; scanId?: string }
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
    return this.prisma.scanJob.create({
      data: { hostId: dto.hostId, rootPath: dto.rootPath, label: dto.label, kind: dto.kind },
    });
  }

  async rescan(volumeId: string) {
    const v = await this.prisma.volume.findUnique({ where: { id: volumeId } });
    if (!v) throw new NotFoundException('Volume inconnu');
    return this.enqueue({ hostId: v.hostId, rootPath: v.rootPath, label: v.label, kind: v.kind as CreateScanJobDto['kind'] });
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
    const rows = await this.prisma.$queryRaw<{ id: string; root_path: string; label: string; kind: string }[]>`
      UPDATE scan_jobs SET status = 'running', started_at = now(), phase = NULL, files_seen = 0
      WHERE id = (SELECT id FROM scan_jobs WHERE host_id = ${host.id} AND status = 'queued'
                  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, root_path, label, kind`;
    const j = rows[0];
    return { job: j ? { id: j.id, rootPath: j.root_path, label: j.label, kind: j.kind } : null };
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
}
