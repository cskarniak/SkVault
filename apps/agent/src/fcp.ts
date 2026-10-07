/**
 * Inspection des bibliothèques Final Cut (agent).
 *
 * Une bibliothèque est reconnue à ses FICHIERS SIGNATURE (`CurrentVersion.flexolibrary`) ou à l'extension `.fcpbundle`, car sur un disque
 * formaté pour Windows le paquet perd son statut de « bundle » (et une bibliothèque peut même occuper la racine du disque).
 * L'inspection ne lit que les métadonnées (lstat) : aucun contenu de fichier n'est lu, aucun lien symbolique n'est suivi.
 * Ce module n'a aucun effet de bord à l'import (testable seul).
 */
import { lstat, readdir, readlink, stat } from 'fs/promises';
import { basename, join, resolve, sep } from 'path';
import {
  FCP_CATEGORIES,
  type FcpCategory,
  type FcpReport,
  type ReportLevel,
  type Verdict,
} from '@skvault/shared';

export const LIBRARY_SIGNATURE = 'CurrentVersion.flexolibrary';
const EVENT_DB = 'currentversion.fcpevent';
const LIBRARY_FILES = new Set([LIBRARY_SIGNATURE.toLowerCase(), 'currentversion.plist', 'settings.plist', 'effects.map', EVENT_DB]);

/** Noms de fichiers/dossiers sans valeur pour une restauration (comparés en minuscules). */
const CACHE_NAMES = new Set([
  '.fcpcache', '__temp', '__sync__', '.lock', '.lock-dir', '.lock-info', '.ds_store', 'thumbs.db', 'desktop.ini',
  '$recycle.bin', 'system volume information', '.spotlight-v100', '.fseventsd', '.trashes', '.temporaryitems',
]);
/** Dossiers jamais explorés pour chercher des bibliothèques */
const SKIP_DISCOVERY = new Set(['$recycle.bin', 'system volume information', '.spotlight-v100', '.fseventsd', '.trashes', '@recycle', '#recycle', '@eadir']);

const isCacheName = (lower: string) => CACHE_NAMES.has(lower) || lower.startsWith('._');

/** Catégorie d'un élément d'après son chemin relatif à la racine de la bibliothèque (segments). */
export function categorize(parts: string[]): FcpCategory {
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.some(isCacheName)) return 'cache_temp'; // prioritaire : un .DS_Store dans « Original Media » reste inutile
  if (lower.includes('original media')) return 'original_media';
  if (lower.includes('transcoded media')) return 'transcoded_media';
  if (lower.includes('render files')) return 'render_files';
  if (lower.includes('analysis files')) return 'analysis_files';
  if (lower[0]?.startsWith('motion templates')) return 'motion_templates';
  const base = lower[lower.length - 1] ?? '';
  if ((parts.length === 1 || (parts.length === 2 && base === EVENT_DB)) && LIBRARY_FILES.has(base)) return 'library_files';
  return 'other';
}

/** Ce dossier est-il la racine d'une bibliothèque Final Cut ? `names` = noms de ses entrées. */
export function isLibraryDir(dirName: string, names: string[]): boolean {
  return dirName.toLowerCase().endsWith('.fcpbundle') || names.includes(LIBRARY_SIGNATURE);
}

/** Provenance d'un média externe : « /Volumes/NEW », « /Users/emma » (un autre ordinateur), « D:\\Projets »… */
export function sourceOf(target: string): string {
  const parts = target.split(/[\\/]+/).filter(Boolean);
  if (/^[A-Za-z]:/.test(target)) return parts.slice(0, 2).join('\\');
  if (/^\/(Volumes|Users|media|mnt|run\/media|home)\//.test(target)) return '/' + parts.slice(0, target.startsWith('/run/media') ? 3 : 2).join('/');
  return '/' + (parts[0] ?? '');
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

interface Warning { level: ReportLevel; code: string; message: string }

/** Verdict : une erreur ⇒ incomplet ; sinon un avertissement ⇒ à vérifier ; sinon complet. Les infos n'ont pas d'effet. */
export function verdictOf(warnings: Warning[]): Verdict {
  if (warnings.some((w) => w.level === 'error')) return 'incomplete';
  if (warnings.some((w) => w.level === 'warn')) return 'to_check';
  return 'complete';
}

export interface InspectOptions {
  /** Appelé régulièrement avec le nombre d'éléments vus ; peut lever une erreur (annulation). */
  tick?: (seen: number) => Promise<void>;
  /** Détection des bibliothèques imbriquées (leur contenu n'est pas compté dans la bibliothèque parente) */
  isNestedLibrary?: (dirName: string, names: string[]) => boolean;
}

export interface InspectResult {
  report: FcpReport;
  verdict: Verdict;
  size: number;
  fileCount: number;
  mtimeMs: number;
  /** Chemins absolus des bibliothèques imbriquées trouvées */
  nested: string[];
}

const emptyCategories = () => Object.fromEntries(FCP_CATEGORIES.map((c) => [c, { files: 0, bytes: 0 }])) as FcpReport['categories'];

/** Parcours en métadonnées seules d'une bibliothèque : tailles par catégorie, événements, liens, avertissements. */
export async function inspectLibrary(root: string, opts: InspectOptions = {}): Promise<InspectResult> {
  const categories = emptyCategories();
  const events = new Map<string, FcpReport['events'][number]>();
  const symlinks: FcpReport['symlinks'] = [];
  const deps = new Map<string, { source: string; links: number; reachable: number }>();
  let brokenLinks = 0;
  let brokenSample: string | undefined;
  let unreadablePath: string | undefined;
  const nested: string[] = [];
  const zeroByteMedia: string[] = [];
  let zeroByteCount = 0;
  let unreadable = 0;
  let appleDouble = 0;
  let totalBytes = 0;
  let totalFiles = 0;
  let mtimeMs = 0;
  let seen = 0;
  let hasLibraryFile = false;
  let hasSettings = false;
  let hasLock = false;
  let cacheLink: string | undefined;

  const ev = (name: string) => {
    let e = events.get(name);
    if (!e) events.set(name, (e = { name, hasEventDb: false, originalFiles: 0, originalBytes: 0, hasTranscoded: false, linkedFiles: 0 }));
    return e;
  };

  async function walk(dir: string, rel: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      unreadable++;
      unreadablePath ??= rel.join('/') || '(racine)';
      return;
    }
    // Bibliothèque imbriquée (jamais dans la corbeille ou les dossiers système : un projet supprimé n'en est pas un) : traitée comme projet distinct, son contenu n'est pas compté dans la bibliothèque parente.
    if (rel.length > 0 && !rel.some((seg) => isCacheName(seg.toLowerCase())) && opts.isNestedLibrary?.(basename(dir), entries.map((e) => e.name))) {
      nested.push(dir);
      return;
    }
    // lstat des entrées par lots (utile sur disques réseau) ; aucun lien suivi
    for (let i = 0; i < entries.length; i += 32) {
      const batch = entries.slice(i, i + 32);
      const stats = await Promise.all(batch.map((e) => lstat(join(dir, e.name)).catch(() => null)));
      for (let j = 0; j < batch.length; j++) {
        const e = batch[j]!;
        const st = stats[j];
        const parts = [...rel, e.name];
        const abs = join(dir, e.name);
        if (!st) { unreadable++; continue; }
        if (++seen % 500 === 0 && opts.tick) await opts.tick(seen);

        if (st.isSymbolicLink()) {
          const cat = categorize(parts);
          categories[cat].files++;
          totalFiles++;
          if (cat === 'cache_temp') {
            if (e.name.toLowerCase() === '.fcpcache') cacheLink = await readlink(abs).catch(() => undefined);
            continue;
          }
          const target = await readlink(abs).catch(() => '');
          const resolved = resolve(dir, target);
          const exists = await stat(abs).then(() => true).catch(() => false);
          const external = !under(resolved, root);
          if (cat === 'original_media' && parts.length >= 2) ev(parts[0]!).linkedFiles++;
          if (!external && !exists) { brokenLinks++; brokenSample ??= parts.join('/'); } // cible DANS la bibliothèque et disparue : cassé
          if (external) {
            const source = sourceOf(resolved);
            const d = deps.get(source) ?? { source, links: 0, reachable: 0 };
            d.links++;
            if (exists) d.reachable++;
            deps.set(source, d);
          }
          if (symlinks.length < 100) symlinks.push({ path: parts.join('/'), target, broken: !exists, external });
          continue;
        }
        if (st.isDirectory()) {
          if (rel.length === 0 && !isCacheName(e.name.toLowerCase()) && !e.name.toLowerCase().startsWith('motion templates')) ev(e.name);
          if (e.name.toLowerCase() === '.lock-dir') hasLock = true;
          await walk(abs, parts);
          continue;
        }
        if (!st.isFile()) continue;

        const lower = e.name.toLowerCase();
        const cat = categorize(parts);
        categories[cat].files++;
        categories[cat].bytes += st.size;
        totalFiles++;
        totalBytes += st.size;
        if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        if (lower.startsWith('._')) appleDouble++;
        if (rel.length === 0) {
          if (lower === LIBRARY_SIGNATURE.toLowerCase()) hasLibraryFile = true;
          if (lower === 'settings.plist') hasSettings = true;
          if (lower === '.lock-info' || lower === '.lock') hasLock = true;
        }
        const top = parts[0]!;
        if (parts.length >= 2 && rel.length >= 1) {
          if (cat === 'original_media') { const x = ev(top); x.originalFiles++; x.originalBytes += st.size; if (st.size === 0) { zeroByteCount++; if (zeroByteMedia.length < 5) zeroByteMedia.push(parts.join('/')); } }
          else if (cat === 'transcoded_media') ev(top).hasTranscoded = true;
          else if (lower === EVENT_DB && parts.length === 2) ev(top).hasEventDb = true;
        }
      }
    }
  }

  await walk(root, []);

  // Événements = dossiers de premier niveau portant l'une des marques d'un événement ; les autres sont de simples dossiers.
  const eventList = [...events.values()].filter((e) => e.hasEventDb || e.originalFiles > 0 || e.hasTranscoded);
  const warnings: Warning[] = [];
  const add = (level: ReportLevel, code: string, message: string) => warnings.push({ level, code, message });

  if (!hasLibraryFile) add('error', 'no_library_file', `Fichier ${LIBRARY_SIGNATURE} absent : la bibliothèque ne peut pas être ouverte.`);
  if (hasLibraryFile && !hasSettings) add('warn', 'no_settings', 'Settings.plist absent à la racine de la bibliothèque.');
  if (eventList.length === 0) add('warn', 'no_events', 'Aucun événement détecté dans cette bibliothèque.');
  for (const e of eventList) {
    if (!e.hasEventDb) add('error', 'event_without_db', `Événement « ${e.name} » : base CurrentVersion.fcpevent absente, ses médias ne sont pas restaurables.`);
    else if (e.originalFiles === 0 && e.linkedFiles === 0) {
      add('warn', 'event_no_media', `Événement « ${e.name} » : aucun média (ni dans la bibliothèque, ni en lien).`);
    }
  }
  if (brokenLinks) add('error', 'broken_links', `${brokenLinks} lien(s) interne(s) vers des médias disparus (ex. ${brokenSample}).`);

  // Dépendances externes : médias laissés « sur place » (autres disques, autre ordinateur). La bibliothèque seule ne suffit alors pas à restaurer le projet.
  const dependencies = [...deps.values()].sort((a, b) => b.links - a.links);
  const depLinks = dependencies.reduce((n, d) => n + d.links, 0);
  const depReachable = dependencies.reduce((n, d) => n + d.reachable, 0);
  if (depLinks) {
    const list = dependencies.slice(0, 4).map((d) => `${d.source} (${d.links})`).join(', ') + (dependencies.length > 4 ? '…' : '');
    if (depReachable < depLinks) {
      add('error', 'external_missing',
        `${depLinks - depReachable} média(s) sur ${depLinks} sont hors de la bibliothèque ET introuvables depuis cette machine : ils restent sur ${list}. Sans ces sources, le projet n'est pas restaurable en entier.`);
    }
    if (depReachable > 0) {
      add('warn', 'external_links', `${depReachable} média(s) hors de la bibliothèque, accessibles ici pour l'instant (${list}) : à sauvegarder avec le projet.`);
    }
  }
  if (zeroByteCount) add('warn', 'zero_byte_media', `${zeroByteCount} média(s) original(aux) de taille nulle (copie interrompue ?), ex. ${zeroByteMedia[0]}.`);
  if (unreadable) add('warn', 'unreadable', `${unreadable} élément(s) illisible(s) pendant l'inspection (ex. ${unreadablePath}) : le contenu mesuré est incomplet.`);
  if (hasLock) add('info', 'lock_files', 'Fichiers de verrou présents (.lock) : la bibliothèque était peut-être ouverte au moment de la copie. Ouvrez-la une fois dans Final Cut pour confirmer.');
  if (cacheLink) add('info', 'cache_link', `.fcpcache pointe vers ${cacheLink} (un autre ordinateur) : inutile pour la restauration.`);
  if (appleDouble) add('info', 'appledouble', `${appleDouble} fichier(s) ._* (métadonnées macOS) sans valeur.`);
  if (nested.length) add('info', 'nested_library', `${nested.length} autre(s) bibliothèque(s) imbriquée(s), comptée(s) comme projet(s) distinct(s).`);

  const report: FcpReport = {
    version: 1,
    totalBytes,
    totalFiles,
    categories,
    events: eventList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    symlinks,
    dependencies,
    brokenLinks,
    warnings,
    nestedLibraries: nested,
  };
  return { report, verdict: verdictOf(warnings), size: totalBytes, fileCount: totalFiles, mtimeMs, nested };
}

/**
 * Cherche les bibliothèques sous `root` sans lister les fichiers : seuls les dossiers sont parcourus, jusqu'à `maxDepth`,
 * et on ne descend pas dans une bibliothèque trouvée (ses éventuelles bibliothèques imbriquées sont gérées par `inspectLibrary`).
 */
export async function* discoverLibraries(root: string, maxDepth = 6, tick?: (seen: number) => Promise<void>): AsyncGenerator<string> {
  let seen = 0;
  async function* visit(dir: string, depth: number): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (++seen % 50 === 0 && tick) await tick(seen);
    if (isLibraryDir(basename(dir), entries.map((e) => e.name))) { yield dir; return; }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DISCOVERY.has(e.name.toLowerCase())) continue;
      yield* visit(join(dir, e.name), depth + 1);
    }
  }
  yield* visit(root, 0);
}


