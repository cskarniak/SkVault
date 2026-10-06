import { z } from 'zod';

export const VOLUME_KINDS = ['internal', 'ssd', 'das', 'nas', 'backup', 'other'] as const;
export type VolumeKind = (typeof VOLUME_KINDS)[number];

export const VOLUME_KIND_LABELS: Record<VolumeKind, string> = {
  internal: 'Disque interne',
  ssd: 'SSD externe',
  das: 'DAS',
  nas: 'NAS',
  backup: 'Sauvegarde',
  other: 'Autre',
};

/** Contrats agent → API (ingestion) */
export const startScanSchema = z.object({
  hostName: z.string().min(1),
  os: z.string().optional(),
  volume: z.object({
    label: z.string().min(1),
    rootPath: z.string().min(1),
    kind: z.enum(VOLUME_KINDS).default('other'),
    totalBytes: z.number().nonnegative().optional(),
    freeBytes: z.number().nonnegative().optional(),
  }),
});
export type StartScanDto = z.infer<typeof startScanSchema>;

export const scanFileSchema = z.object({
  relPath: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** ISO 8601 */
  mtime: z.string(),
  quickHash: z.string().optional(),
  /** MD5 complet hérité de l'ancien index dedup (import uniquement) */
  md5: z.string().optional(),
});
export const pushFilesSchema = z.object({ files: z.array(scanFileSchema).max(5000) });
export type ScanFileDto = z.infer<typeof scanFileSchema>;

export const pushHashesSchema = z.object({
  hashes: z.array(z.object({ relPath: z.string().min(1), hash: z.string().min(1) })).max(5000),
});
export type PushHashesDto = z.infer<typeof pushHashesSchema>;

/** Scans déclenchés depuis le web */
export const createScanJobSchema = z.object({
  hostId: z.string().min(1),
  rootPath: z
    .string()
    .regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, 'Chemin absolu requis (ex. /Volumes/MonDisque ou D:\\Photos)'),
  label: z.string().min(1),
  kind: z.enum(VOLUME_KINDS).default('other'),
});
export type CreateScanJobDto = z.infer<typeof createScanJobSchema>;

export const SCAN_JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type ScanJobStatus = (typeof SCAN_JOB_STATUSES)[number];

/** Protocole agent ⇄ API pour les jobs */
export const agentIdentitySchema = z.object({ hostName: z.string().min(1), os: z.string().optional() });
export const jobProgressSchema = z.object({
  phase: z.enum(['listing', 'hashing']),
  filesSeen: z.number().int().nonnegative(),
  scanId: z.string().optional(),
});
export const jobFinishSchema = z.object({
  status: z.enum(['done', 'failed', 'cancelled']),
  message: z.string().max(1000).optional(),
  filesSeen: z.number().int().nonnegative().optional(),
});

export const createEnrollmentSchema = z.object({
  hostName: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'Lettres, chiffres, point, tiret, souligné (64 max)').optional(),
});

/** Sélecteur de dossier : web → API, puis agent → API */
export const browseRequestSchema = z.object({ path: z.string().optional() });
export interface BrowseEntry { name: string; path: string }
export interface BrowseResult {
  /** Dossier listé ('' = liste des emplacements autorisés) */
  path: string;
  /** Dossier parent ('' = remonter à la liste des emplacements ; null = déjà à cette liste) */
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
}
export const browseResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(z.object({ name: z.string(), path: z.string() })).max(2000),
    truncated: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string().max(500) }),
]);
