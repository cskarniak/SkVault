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

export const SCAN_MODES = ['duplicates', 'fcp_archive'] as const;
export type ScanMode = (typeof SCAN_MODES)[number];
export const SCAN_MODE_LABELS: Record<ScanMode, string> = {
  duplicates: 'Doublons',
  fcp_archive: 'Archive de projets Final Cut',
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
  /** Absent = on suit le type déjà enregistré pour ce volume (« duplicates » pour un nouveau volume). */
  mode: z.enum(SCAN_MODES).optional(),
  /** Changement de type confirmé par l'utilisateur : les données de l'ancien type sont supprimées. */
  allowModeChange: z.boolean().optional(),
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
  /** Obligatoire : le type de scan est choisi explicitement (« duplicates » ou « fcp_archive »). */
  mode: z.enum(SCAN_MODES, { required_error: 'Choisissez le type de scan', invalid_type_error: 'Choisissez le type de scan' }),
  confirmModeChange: z.boolean().optional(),
});
export type CreateScanJobDto = z.infer<typeof createScanJobSchema>;

export const SCAN_JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type ScanJobStatus = (typeof SCAN_JOB_STATUSES)[number];

/** Protocole agent ⇄ API pour les jobs */
export const agentIdentitySchema = z.object({ hostName: z.string().min(1), os: z.string().optional() });
export const jobProgressSchema = z.object({
  phase: z.enum(['listing', 'hashing', 'inspecting']),
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

// ── Projets (archives Final Cut, photothèques) ────────────────────────────────────────────────────────────
export const PROJECT_KINDS = ['fcp_library', 'photo_library'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  fcp_library: 'Bibliothèque Final Cut',
  photo_library: 'Photothèque iPhoto/Photos',
};

export const VERDICTS = ['complete', 'to_check', 'incomplete'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABELS: Record<Verdict, string> = {
  complete: 'Complet',
  to_check: 'À vérifier',
  incomplete: 'Incomplet',
};

export const FCP_CATEGORIES = [
  'original_media', 'transcoded_media', 'render_files', 'analysis_files', 'library_files', 'motion_templates', 'cache_temp', 'other',
] as const;
export type FcpCategory = (typeof FCP_CATEGORIES)[number];

/** Utilité d'une catégorie pour la restauration : indispensable, régénérable (Final Cut la recrée), conditionnelle, inutile. */
export type Usefulness = 'essential' | 'regenerable' | 'conditional' | 'useless' | 'unknown';
export const FCP_CATEGORY_INFO: Record<FcpCategory, { label: string; usefulness: Usefulness; hint: string }> = {
  original_media: { label: 'Médias originaux', usefulness: 'essential', hint: 'Vos vrais médias importés : jamais inutiles.' },
  library_files: { label: 'Bibliothèque et événements', usefulness: 'essential', hint: 'Bases de données de la bibliothèque et des événements, réglages.' },
  motion_templates: { label: 'Modèles Motion', usefulness: 'essential', hint: 'Titres et effets personnalisés embarqués dans la bibliothèque.' },
  transcoded_media: { label: 'Médias transcodés (optimisés / proxy)', usefulness: 'conditional', hint: 'Régénérables par Final Cut à condition que les médias originaux soient présents.' },
  render_files: { label: 'Fichiers de rendu', usefulness: 'regenerable', hint: 'Recréés automatiquement par Final Cut.' },
  analysis_files: { label: "Fichiers d'analyse", usefulness: 'regenerable', hint: 'Recréés automatiquement par Final Cut.' },
  cache_temp: { label: 'Caches, temporaires, verrous, métadonnées système', usefulness: 'useless', hint: '.fcpcache, __Temp, .lock*, ._*, .DS_Store, corbeille Windows… sans valeur pour une restauration.' },
  other: { label: 'Autres dossiers et fichiers', usefulness: 'unknown', hint: 'Exports, dossiers personnels, etc. : à juger au cas par cas.' },
};

export type ReportLevel = 'info' | 'warn' | 'error';
export interface FcpReport {
  version: 1;
  totalBytes: number;
  totalFiles: number;
  categories: Record<FcpCategory, { files: number; bytes: number }>;
  events: { name: string; hasEventDb: boolean; originalFiles: number; originalBytes: number; hasTranscoded: boolean; linkedFiles: number }[];
  /** Échantillon (100 max) des liens de médias ; les totaux exacts sont dans `dependencies` et `brokenLinks` */
  symlinks: { path: string; target: string; broken: boolean; external: boolean }[];
  /** Médias référencés HORS de la bibliothèque (Final Cut « laisser les fichiers en place »), regroupés par source */
  dependencies: { source: string; links: number; reachable: number }[];
  /** Liens situés DANS la bibliothèque dont la cible a disparu (réellement cassés) */
  brokenLinks: number;
  warnings: { level: ReportLevel; code: string; message: string }[];
  /** Chemins (relatifs au volume) d'autres bibliothèques imbriquées, traitées comme projets distincts */
  nestedLibraries: string[];
}

export const projectSchema = z.object({
  kind: z.enum(PROJECT_KINDS),
  name: z.string().min(1),
  relPath: z.string(),
  size: z.number().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
  verdict: z.enum(VERDICTS).optional(),
  report: z.unknown().optional(),
});
export const pushProjectsSchema = z.object({ projects: z.array(projectSchema).max(500) });
export type ProjectDto = z.infer<typeof projectSchema>;

export const patchVolumeSchema = z.object({
  note: z.string().max(2000).nullable().optional(),
  physicalLocation: z.string().max(200).nullable().optional(),
});
