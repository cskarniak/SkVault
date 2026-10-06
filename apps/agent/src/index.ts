/**
 * Agent de scan SkVault — à lancer sur chaque machine qui voit des disques.
 *
 *   pnpm agent scan <chemin> --label "SSD Photos" --kind ssd [--host nom-machine]
 *
 *   pnpm agent run [--host nom-machine] [--allow /Volumes,/mnt]
 *     Démon : reste en veille, interroge l'API et exécute les scans lancés depuis l'interface web.
 *     Ne scanne que sous les dossiers autorisés (SKVAULT_ALLOWED_ROOTS ou --allow ; défaut : $HOME, /Volumes,
 *     /mnt, /media, /run/media).
 *
 *   pnpm agent import-dedup <dedup.sqlite> [--host nom-machine] [--kind nas|ssd|...] [--skip-doublons]
 *                           [--remap /Volumes/photo_bbl=/mnt/nas/photo_bbl ...]
 *     Reprend l'ancien index Python (dossier dedup/) sans relire les disques.
 *
 * Env : SKVAULT_URL (ex. https://skvault.home/api), SKVAULT_AGENT_TOKEN.
 * Lecture seule : l'agent ne modifie jamais les fichiers scannés.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync, statfsSync } from 'fs';
import { opendir } from 'fs/promises';
import { homedir, hostname, platform } from 'os';
import { dirname, join, relative, sep, win32 } from 'path';
import { VOLUME_KINDS, type BrowseResult, type ScanFileDto } from '@skvault/shared';

const BATCH = 2000;
const QUICK_CHUNK = 64 * 1024;
const IGNORED_NAMES = new Set([
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', '$RECYCLE.BIN',
  'System Volume Information', 'lost+found', '.git', 'node_modules',
  // Windows : fichiers système volumineux à la racine des lecteurs
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'DumpStack.log.tmp',
]);

/**
 * Toujours exclus (comme l'ancien outil dedup) : miniatures et corbeilles/instantanés de NAS
 * (QNAP : `@Recycle`, `.@__thumb`, `@Recently-Snapshot` ; Synology : `#recycle`, `@eaDir`), qui pollueraient
 * le catalogue de faux doublons. Comparaison sur le nom, sans casse.
 */
const EXCLUDED_NAME_PARTS = ['thumb', '@recycle', '#recycle', '@recently-snapshot', '@eadir'];
const isExcludedName = (name: string) => {
  const n = name.toLowerCase();
  return EXCLUDED_NAME_PARTS.some((p) => n.includes(p));
};

const BASE = (process.env['SKVAULT_URL'] ?? 'http://localhost:3011/api').replace(/\/$/, '');
const TOKEN = process.env['SKVAULT_AGENT_TOKEN'] ?? process.env['AGENT_TOKEN'] ?? '';

const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => request<T>(method, `/ingest/scans${path}`, body);
const agentCall = <T>(path: string, body?: unknown) => request<T>('POST', `/ingest/agent${path}`, body);

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** SHA-1 de la taille + 64 Ko de début + 64 Ko de fin : rapide, suffisant pour préfiltrer. */
function quickHash(file: string, size: number): string {
  const h = createHash('sha1').update(String(size));
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(QUICK_CHUNK);
    let n = readSync(fd, buf, 0, QUICK_CHUNK, 0);
    h.update(buf.subarray(0, n));
    if (size > QUICK_CHUNK) {
      n = readSync(fd, buf, 0, QUICK_CHUNK, Math.max(0, size - QUICK_CHUNK));
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

async function fullHash(file: string): Promise<string> {
  const { createReadStream } = await import('fs');
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function* walk(dir: string): AsyncGenerator<string> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (e) {
    console.warn(`  ! illisible : ${dir} (${(e as Error).message})`);
    return;
  }
  for await (const entry of handle) {
    if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith('._') || isExcludedName(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** Levée quand l'utilisateur annule le scan depuis le web. */
class CancelledError extends Error {}

interface ScanOptions {
  label?: string;
  kind?: (typeof VOLUME_KINDS)[number];
  host?: string;
  /** Appelé régulièrement ; renvoie true si l'annulation a été demandée. */
  report?: (p: { phase: 'listing' | 'hashing'; filesSeen: number; scanId: string }) => Promise<boolean>;
}

async function scan(root: string, opts: ScanOptions = {}) {
  const label = opts.label ?? root.split(sep).filter(Boolean).pop() ?? root;
  const kind = opts.kind ?? 'other';
  if (!VOLUME_KINDS.includes(kind)) throw new Error(`--kind doit valoir : ${VOLUME_KINDS.join(', ')}`);

  let totalBytes: number | undefined;
  let freeBytes: number | undefined;
  try {
    const fs = statfsSync(root);
    totalBytes = fs.blocks * fs.bsize;
    freeBytes = fs.bavail * fs.bsize;
  } catch { /* NAS / FS sans statfs : on s'en passe */ }

  const { scanId } = await call<{ scanId: string }>('POST', '', {
    hostName: opts.host ?? hostname(),
    os: platform(),
    volume: { label, rootPath: root, kind, totalBytes, freeBytes },
  });
  console.log(`Scan ${scanId} — ${label} (${root})`);

  let lastReport = 0;
  const tick = async (phase: 'listing' | 'hashing', filesSeen: number) => {
    if (!opts.report || Date.now() - lastReport < 2000) return;
    lastReport = Date.now();
    if (await opts.report({ phase, filesSeen, scanId })) throw new CancelledError('Annulé');
  };

  let batch: ScanFileDto[] = [];
  let seen = 0;
  const flush = async () => {
    if (batch.length) await call('POST', `/${scanId}/files`, { files: batch });
    batch = [];
  };

  for await (const file of walk(root)) {
    try {
      const st = statSync(file);
      batch.push({
        relPath: relative(root, file).split(sep).join('/'),
        size: st.size,
        mtime: st.mtime.toISOString(),
        quickHash: st.size > 0 ? quickHash(file, st.size) : undefined,
      });
      seen++;
    } catch (e) {
      console.warn(`  ! ignoré : ${file} (${(e as Error).message})`);
    }
    if (batch.length >= BATCH) {
      await flush();
      process.stdout.write(`\r  ${seen} fichiers…`);
    }
    await tick('listing', seen);
  }
  await flush();
  console.log(`\r  ${seen} fichiers listés.`);

  // Hash complet des seuls candidats doublons (même taille + quickHash qu'un autre fichier du catalogue).
  for (;;) {
    const { relPaths } = await call<{ relPaths: string[] }>('GET', `/${scanId}/pending-hashes`);
    if (relPaths.length === 0) break;
    console.log(`  hash complet de ${relPaths.length} fichiers candidats…`);
    const hashes: { relPath: string; hash: string }[] = [];
    for (const relPath of relPaths) {
      try {
        hashes.push({ relPath, hash: await fullHash(join(root, ...relPath.split('/'))) });
        await tick('hashing', seen);
      } catch (e) {
        console.warn(`  ! hash impossible : ${relPath} (${(e as Error).message})`);
      }
    }
    await call('POST', `/${scanId}/hashes`, { hashes });
    // Sans progrès (fichiers illisibles) on arrête pour ne pas boucler.
    if (hashes.length === 0) break;
  }

  const result = await call<{ filesSeen: number; filesRemoved: number }>('POST', `/${scanId}/finish`);
  console.log(`Terminé : ${result.filesSeen} fichiers, ${result.filesRemoved} retirés du catalogue.`);
  return result;
}

/** Import de l'ancien index `dedup.sqlite` : un volume par `dir_root`, fichiers poussés par le protocole habituel. */
async function importDedup(sqlitePath: string) {
  const kind = (arg('kind') ?? 'other') as (typeof VOLUME_KINDS)[number];
  if (!VOLUME_KINDS.includes(kind)) throw new Error(`--kind doit valoir : ${VOLUME_KINDS.join(', ')}`);
  const skipDoublons = process.argv.includes('--skip-doublons');
  // --remap ancien=nouveau (répétable) : range les fichiers sous le chemin de montage de la machine qui scannera
  // réellement (ex. le NAS monté sur le serveur), pour que ce scan retombe sur les mêmes volumes.
  const remaps = new Map<string, string>();
  process.argv.forEach((a, i) => {
    if (a !== '--remap') return;
    const [from, to] = (process.argv[i + 1] ?? '').split('=');
    if (!from || !to) throw new Error('--remap attend ancien=nouveau (ex. /Volumes/photo_bbl=/mnt/nas/photo_bbl)');
    remaps.set(from.replace(/\/$/, ''), to.replace(/\/$/, ''));
  });
  const sql = (q: string) =>
    JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', sqlitePath, q], { maxBuffer: 1 << 30 }).toString() || '[]');

  const roots: { dir_root: string; media_name: string | null }[] = sql(
    'SELECT dir_root, max(media_name) AS media_name FROM files GROUP BY dir_root ORDER BY dir_root',
  );
  const host = arg('host') ?? hostname();

  for (const { dir_root, media_name } of roots) {
    const quoted = dir_root.replace(/'/g, "''");
    const rows: { path: string; size: number; mtime: number; md5: string | null }[] = sql(
      `SELECT path, size, mtime, md5 FROM files WHERE dir_root = '${quoted}'` +
        (skipDoublons ? " AND path NOT LIKE '%/doublons/%'" : ''),
    );
    const label = media_name ?? dir_root.split('/').filter(Boolean).pop() ?? dir_root;
    const rootPath = remaps.get(dir_root.replace(/\/$/, '')) ?? dir_root;
    const { scanId } = await call<{ scanId: string }>('POST', '', {
      hostName: host, os: platform(), volume: { label, rootPath, kind },
    });
    console.log(`Import ${label} (${dir_root}${rootPath !== dir_root ? ` → ${rootPath}` : ''}) : ${rows.length} fichiers`);

    const prefix = dir_root.endsWith('/') ? dir_root : `${dir_root}/`;
    for (let i = 0; i < rows.length; i += BATCH) {
      const files: ScanFileDto[] = rows.slice(i, i + BATCH).map((r) => ({
        relPath: r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path,
        size: r.size,
        // Tronqué à la milliseconde comme `Date` côté scan : un re-scan retrouve la même date et garde le MD5.
        mtime: new Date(Math.floor(r.mtime * 1000)).toISOString(),
        md5: r.md5 ?? undefined,
      }));
      await call('POST', `/${scanId}/files`, { files });
      process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
    }
    const result = await call<{ filesSeen: number; filesRemoved: number }>('POST', `/${scanId}/finish`);
    console.log(`\r  Terminé : ${result.filesSeen} fichiers, ${result.filesRemoved} retirés.`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dossiers scannables par défaut : le dossier personnel et là où les disques se montent. */
function defaultRoots(): string[] {
  if (platform() === 'win32') {
    // Lecteurs présents (C:\, D:\…, y compris lecteurs réseau mappés)
    const drives = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`).filter((d) => existsSync(d));
    return [homedir(), ...drives];
  }
  return [homedir(), '/Volumes', '/mnt', '/media', '/run/media'];
}

function allowedRoots(): string[] {
  const raw = arg('allow') ?? process.env['SKVAULT_ALLOWED_ROOTS'];
  // Le « : » des lecteurs Windows interdit ce séparateur sous Windows : « ; » ou « , »
  const roots = raw ? raw.split(platform() === 'win32' ? /[;,]/ : /[,:]/).filter(Boolean) : defaultRoots();
  return roots.flatMap((r) => {
    try { return [realpathSync(r)]; } catch { return []; }
  });
}

/** `real` est-il `root` ou un descendant ? Sous Windows : séparateur « \\ » et casse ignorée. */
function isUnderRoot(real: string, root: string, windows = platform() === 'win32'): boolean {
  const pathSep = windows ? win32.sep : sep;
  const norm = (p: string) => (windows ? p.toLowerCase() : p);
  const r = norm(root.endsWith(pathSep) ? root : root + pathSep); // « D:\ » se termine déjà par un séparateur
  const x = norm(real.endsWith(pathSep) ? real : real + pathSep);
  return x.startsWith(r);
}

/** Refuse tout chemin hors des dossiers autorisés (liens symboliques résolus). */
function checkAllowed(path: string, roots: string[]): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`Chemin introuvable sur cette machine : ${path} (disque non branché ?)`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`Ce n'est pas un dossier : ${path}`);
  if (!roots.some((r) => isUnderRoot(real, r))) {
    throw new Error(`Chemin hors des dossiers autorisés sur cette machine (${roots.join(', ')})`);
  }
  return real;
}


const BROWSE_MAX_ENTRIES = 2000;

/** Dossier (ou lien vers un dossier) ? Les liens sont suivis pour l'affichage ; l'entrée reste soumise à checkAllowed. */
function isDirEntry(entry: import('fs').Dirent, full: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(full).isDirectory(); } catch { return false; }
}

/**
 * Sélecteur de dossier de l'interface web : liste les SOUS-DOSSIERS d'un chemin (jamais les fichiers), uniquement
 * dans les dossiers autorisés. `requested` vide = liste des emplacements autorisés eux-mêmes.
 */
async function browse(roots: string[], requested: string | null): Promise<BrowseResult> {
  if (!requested) {
    return { path: '', parent: null, entries: roots.map((r) => ({ name: r, path: r })), truncated: false };
  }
  const real = checkAllowed(requested, roots);
  const entries: BrowseResult['entries'] = [];
  let truncated = false;
  for await (const e of await opendir(real)) {
    const full = join(real, e.name);
    if (e.name.startsWith('.') || IGNORED_NAMES.has(e.name) || isExcludedName(e.name) || !isDirEntry(e, full)) continue;
    if (entries.length >= BROWSE_MAX_ENTRIES) { truncated = true; break; }
    entries.push({ name: e.name, path: full });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const up = dirname(real);
  // Au-dessus d'un emplacement autorisé on retombe sur la liste des emplacements ('').
  const parent = up !== real && roots.some((r) => isUnderRoot(up, r)) ? up : '';
  return { path: real, parent, entries, truncated };
}

/** Boucle indépendante des scans : répond aux demandes de navigation même pendant un scan (long-poll côté API). */
async function browseLoop(identity: { hostName: string; os: string }, roots: string[]) {
  for (;;) {
    try {
      const { request } = await agentCall<{ request: { id: string; path: string | null } | null }>('/browse/poll', identity);
      if (!request) { await sleep(200); continue; }
      let body: object;
      try {
        body = { ok: true, ...(await browse(roots, request.path)) };
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        body = { ok: false, error: err.code === 'EACCES' || err.code === 'EPERM' ? 'Accès refusé à ce dossier' : err.message.slice(0, 400) };
      }
      await agentCall(`/browse/${request.id}/result`, body);
    } catch (e) {
      await sleep(5000);
    }
  }
}

async function runDaemon() {
  const hostName = arg('host') ?? hostname();
  const identity = { hostName, os: platform() };
  const roots = allowedRoots();
  console.log(`Agent SkVault « ${hostName} » → ${BASE}\nDossiers autorisés : ${roots.join(', ') || '(aucun)'}`);

  for (;;) {
    try {
      const { orphansFailed } = await agentCall<{ orphansFailed: number }>('/hello', identity);
      if (orphansFailed) console.log(`${orphansFailed} scan(s) interrompu(s) par un redémarrage précédent.`);
      break;
    } catch (e) {
      console.warn(`API injoignable (${(e as Error).message}), nouvel essai dans 10 s…`);
      await sleep(10_000);
    }
  }

  // Heartbeat indépendant : la machine reste « en ligne » même pendant un long hash de gros fichier.
  setInterval(() => agentCall('/heartbeat', identity).catch(() => undefined), 10_000);
  void browseLoop(identity, roots);

  for (;;) {
    try {
      const { job } = await agentCall<{ job: { id: string; rootPath: string; label: string; kind: string } | null }>(
        '/poll', identity,
      );
      if (job) await runJob(job, hostName, roots);
    } catch (e) {
      console.warn(`Erreur de communication : ${(e as Error).message}`);
    }
    await sleep(3000);
  }
}

async function runJob(job: { id: string; rootPath: string; label: string; kind: string }, host: string, roots: string[]) {
  console.log(`\n▶ Scan demandé depuis le web : ${job.label} (${job.rootPath})`);
  const finish = (status: 'done' | 'failed' | 'cancelled', message?: string, filesSeen?: number) =>
    agentCall(`/jobs/${job.id}/finish`, { status, message: message?.slice(0, 1000), filesSeen }).catch((e) =>
      console.warn(`Impossible de clôturer le job : ${(e as Error).message}`),
    );
  try {
    const root = checkAllowed(job.rootPath, roots);
    const result = await scan(root, {
      label: job.label,
      kind: job.kind as ScanOptions['kind'],
      host,
      report: async (p) =>
        (await agentCall<{ cancel: boolean }>(`/jobs/${job.id}/progress`, p)).cancel,
    });
    await finish('done', `${result.filesSeen} fichiers, ${result.filesRemoved} retirés du catalogue`, result.filesSeen);
  } catch (e) {
    if (e instanceof CancelledError) {
      console.log('  Annulé.');
      await finish('cancelled', 'Annulé depuis l\'interface');
    } else {
      console.error(`  Échec : ${(e as Error).message}`);
      await finish('failed', (e as Error).message);
    }
  }
}

const [cmd, path] = process.argv.slice(2);
if (cmd === 'run') {
  runDaemon().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'import-dedup' && path && statSync(path, { throwIfNoEntry: false })?.isFile()) {
  importDedup(path).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'scan' && path && statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
  scan(path, {
    label: arg('label'),
    kind: arg('kind') as ScanOptions['kind'],
    host: arg('host'),
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.error('Usage :');
  console.error('  pnpm agent run [--host nom] [--allow /Volumes,/mnt]   (démon : scans lancés depuis le web)');
  console.error('  pnpm agent scan <dossier> [--label "Nom"] [--kind ssd|das|nas|internal|backup|other] [--host nom]');
  console.error('  pnpm agent import-dedup <dedup.sqlite> [--host nom] [--kind ...] [--skip-doublons] [--remap ancien=nouveau]');
  process.exit(1);
}
