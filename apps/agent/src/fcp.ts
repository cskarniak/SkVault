/**
 * Inspection des bibliothèques Final Cut (agent).
 *
 * Une bibliothèque est reconnue à ses FICHIERS SIGNATURE (`CurrentVersion.flexolibrary`) ou à l'extension `.fcpbundle`, car sur un disque
 * formaté pour Windows le paquet perd son statut de « bundle » (et une bibliothèque peut même occuper la racine du disque).
 * L'inspection ne lit que les métadonnées (lstat) : aucun contenu de fichier n'est lu, aucun lien symbolique n'est suivi.
 * Ce module n'a aucun effet de bord à l'import (testable seul).
 *
 * Final Cut peut garder les médias « sur place » : `Original Media` ne contient alors que des liens symboliques vers des fichiers
 * situés ailleurs (autre disque, autre ordinateur). Pour juger si un projet est restaurable, chaque lien de média ORIGINAL est
 * résolu dans l'ordre : fichier accessible ici → fichier retrouvé à côté de la bibliothèque (dossier du projet) → introuvable.
 * Les proxys et caches sont régénérables et n'entrent pas dans le verdict.
 */
import { createHash } from 'crypto';
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
  '.fcpcache', '__temp', '__sync__', '__asynccopying', '.lock', '.lock-dir', '.lock-info', '.ds_store', 'thumbs.db', 'desktop.ini',
  '$recycle.bin', 'system volume information', '.spotlight-v100', '.fseventsd', '.trashes', '.temporaryitems',
]);
/** Dossiers jamais explorés pour chercher des bibliothèques */
const SKIP_DISCOVERY = new Set(['$recycle.bin', 'system volume information', '.spotlight-v100', '.fseventsd', '.trashes', '@recycle', '#recycle', '@eadir']);

const MAX_MEDIA_KEYS = 30_000;
const MAX_MISSING = 5_000;
const MAX_NEIGHBOR_FILES = 300_000;

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

/** Nature d'un lien symbolique de la bibliothèque : média original, proxy/optimisé (régénérable), cache (sans valeur) ou autre. */
export type LinkClass = 'original' | 'proxy' | 'cache' | 'other';
export function linkClass(libParts: string[], target: string): LinkClass {
  const low = libParts.map((p) => p.toLowerCase());
  const t = target.toLowerCase();
  if (low.includes('__asynccopying') || low.includes('analysis files') || low.includes('render files') ||
      t.includes('.fcpcache') || t.includes('/analysis files/') || t.includes('/render files/')) return 'cache';
  if (low.includes('transcoded media') || t.includes('proxy media') || t.includes('optimized media')) return 'proxy';
  if (low.includes('original media')) return 'original';
  return 'other';
}

/** Provenance d'un média externe : « /Volumes/NEW », « /Users/emma » (un autre ordinateur), « D:\\Projets »… */
export function sourceOf(target: string): string {
  const parts = target.split(/[\\/]+/).filter(Boolean);
  if (/^[A-Za-z]:/.test(target)) return parts.slice(0, 2).join('\\');
  if (/^\/(Volumes|Users|media|mnt|run\/media|home)\//.test(target)) return '/' + parts.slice(0, target.startsWith('/run/media') ? 3 : 2).join('/');
  return '/' + (parts[0] ?? '');
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

// ── Dossier du projet : fichiers réels voisins de la bibliothèque ─────────────────────────────────────────────────────

export interface NeighborIndex {
  /** Chemins relatifs au dossier du projet (séparateur « / »), minuscules */
  tails: Set<string>;
  /** Noms de fichiers, minuscules */
  names: Set<string>;
  files: number;
  /** false si l'index a été tronqué (dossier trop volumineux) */
  complete: boolean;
}

/**
 * Indexe les FICHIERS RÉELS d'un dossier de projet. Sont exclus : les liens symboliques (un lien n'est pas un média), le contenu des
 * bibliothèques (même celles sans extension .fcpbundle — une bibliothèque voisine porte souvent les mêmes noms de médias) et les caches.
 */
export async function buildNeighborIndex(folder: string, tick?: (n: number) => Promise<void>): Promise<NeighborIndex> {
  const idx: NeighborIndex = { tails: new Set(), names: new Set(), files: 0, complete: true };
  async function walk(dir: string, rel: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel.length > 0 && isLibraryDir(basename(dir), entries.map((e) => e.name))) return; // autre bibliothèque : ses liens ne sont pas des médias
    for (const e of entries) {
      const low = e.name.toLowerCase();
      if (isCacheName(low) || SKIP_DISCOVERY.has(low)) continue;
      if (e.isDirectory()) { await walk(join(dir, e.name), [...rel, e.name]); continue; }
      if (!e.isFile()) continue; // lien symbolique, périphérique… : ignoré
      if (idx.files >= MAX_NEIGHBOR_FILES) { idx.complete = false; return; }
      idx.files++;
      idx.names.add(low);
      idx.tails.add([...rel, e.name].join('/').toLowerCase());
      if (tick && idx.files % 2000 === 0) await tick(idx.files);
    }
  }
  await walk(folder, []);
  return idx;
}

/** Retrouve la cible d'un lien dans le dossier du projet : même chemin relatif (suffixe d'au moins 2 niveaux) ou même nom seul. */
export function matchNeighbor(target: string, idx: NeighborIndex): 'exact' | 'name' | null {
  const parts = target.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  for (let k = 0; k <= parts.length - 2; k++) if (idx.tails.has(parts.slice(k).join('/'))) return 'exact';
  return idx.names.has(parts[parts.length - 1] ?? '') ? 'name' : null;
}

/** Empreinte courte et stable d'un média (12 hex) : permet de comparer deux bibliothèques sans stocker les chemins. */
export function mediaKey(target: string): string {
  const parts = target.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  return createHash('sha1').update(parts.slice(-2).join('/')).digest('hex').slice(0, 12);
}

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
  /** Index du dossier du projet (fichiers réels voisins) ; absent = recherche « à côté » non effectuée */
  neighbors?: NeighborIndex;
  /** Dossier du projet relatif au volume, repris tel quel dans le rapport */
  projectFolder?: string | null;
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

/** Parcours en métadonnées seules d'une bibliothèque : tailles par catégorie, événements, médias originaux, avertissements. */
export async function inspectLibrary(root: string, opts: InspectOptions = {}): Promise<InspectResult> {
  const categories = emptyCategories();
  const events = new Map<string, FcpReport['events'][number]>();
  const symlinks: FcpReport['symlinks'] = [];
  const nested: string[] = [];
  const zeroByteMedia: string[] = [];
  const keys = new Set<string>();
  const missing: string[] = [];
  const absentSources = new Map<string, number>();
  const reachableSources = new Map<string, { links: number }>();
  const originals = { total: 0, internal: 0, reachable: 0, neighborExact: 0, neighborName: 0, absent: 0 };
  const proxies = { total: 0, found: 0, absent: 0 };
  let cacheLinks = 0;
  let otherLinks = 0;
  let zeroByteCount = 0;
  let unreadable = 0;
  let unreadablePath: string | undefined;
  let appleDouble = 0;
  let totalBytes = 0;
  let totalFiles = 0;
  let mtimeMs = 0;
  let lastEditMs = 0;
  let seen = 0;
  let brokenLinks = 0;
  let brokenSample: string | undefined;
  let hasLibraryFile = false;
  let hasSettings = false;
  let hasLock = false;
  let cacheLink: string | undefined;
  let keysTruncated = false;

  const ev = (name: string) => {
    let e = events.get(name);
    if (!e) events.set(name, (e = { name, hasEventDb: false, originalFiles: 0, originalBytes: 0, hasTranscoded: false, linkedFiles: 0 }));
    return e;
  };
  const addKey = (k: string) => { if (keys.size < MAX_MEDIA_KEYS) keys.add(k); else keysTruncated = true; };

  async function walk(dir: string, rel: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      unreadable++;
      unreadablePath ??= rel.join('/') || '(racine)';
      return;
    }
    // Bibliothèque imbriquée : projet distinct, contenu non compté ici (jamais dans la corbeille ou les dossiers système).
    if (rel.length > 0 && !rel.some((seg) => isCacheName(seg.toLowerCase())) && opts.isNestedLibrary?.(basename(dir), entries.map((e) => e.name))) {
      nested.push(dir);
      return;
    }
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
            else cacheLinks++;
            continue;
          }
          const target = await readlink(abs).catch(() => '');
          const resolved = resolve(dir, target);
          const exists = await stat(abs).then(() => true).catch(() => false);
          const external = !under(resolved, root);
          const cls = linkClass(parts, target);
          if (cls === 'original' && parts.length >= 2) ev(parts[0]!).linkedFiles++;
          if (symlinks.length < 100) symlinks.push({ path: parts.join('/'), target, broken: !exists, external });

          if (!external) { // lien vers un fichier DE la bibliothèque
            if (!exists) { brokenLinks++; brokenSample ??= parts.join('/'); }
            else if (cls === 'original') { originals.total++; originals.internal++; addKey(mediaKey(target)); }
            continue;
          }
          if (cls === 'cache') { cacheLinks++; continue; }
          if (cls === 'other') { otherLinks++; continue; }
          // Lien externe : fichier accessible ici ? sinon retrouvé à côté de la bibliothèque ? sinon introuvable.
          const near = exists ? null : opts.neighbors ? matchNeighbor(target, opts.neighbors) : null;
          if (cls === 'proxy') {
            proxies.total++;
            if (exists || near) proxies.found++; else proxies.absent++;
            continue;
          }
          originals.total++;
          addKey(mediaKey(target));
          if (exists) {
            originals.reachable++;
            const r = reachableSources.get(sourceOf(resolved)) ?? { links: 0 };
            r.links++;
            reachableSources.set(sourceOf(resolved), r);
          } else if (near === 'exact') originals.neighborExact++;
          else if (near === 'name') originals.neighborName++;
          else {
            originals.absent++;
            const src = sourceOf(resolved);
            absentSources.set(src, (absentSources.get(src) ?? 0) + 1);
            if (missing.length < MAX_MISSING) missing.push(target);
          }
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
        if (cat === 'library_files' && st.mtimeMs > lastEditMs) lastEditMs = st.mtimeMs;
        if (lower.startsWith('._')) appleDouble++;
        if (rel.length === 0) {
          if (lower === LIBRARY_SIGNATURE.toLowerCase()) hasLibraryFile = true;
          if (lower === 'settings.plist') hasSettings = true;
          if (lower === '.lock-info' || lower === '.lock') hasLock = true;
        }
        const top = parts[0]!;
        if (parts.length >= 2 && rel.length >= 1) {
          if (cat === 'original_media') {
            const x = ev(top);
            x.originalFiles++;
            x.originalBytes += st.size;
            originals.total++;
            originals.internal++;
            addKey(mediaKey('original media/' + lower));
            if (st.size === 0) { zeroByteCount++; if (zeroByteMedia.length < 5) zeroByteMedia.push(parts.join('/')); }
          } else if (cat === 'transcoded_media') ev(top).hasTranscoded = true;
          else if (lower === EVENT_DB && parts.length === 2) ev(top).hasEventDb = true;
        }
      }
    }
  }

  await walk(root, []);

  // Événements = dossiers de premier niveau portant l'une des marques d'un événement ; les autres sont de simples dossiers.
  const eventList = [...events.values()].filter((e) => e.hasEventDb || e.originalFiles > 0 || e.hasTranscoded || e.linkedFiles > 0);
  const warnings: Warning[] = [];
  const add = (level: ReportLevel, code: string, message: string) => warnings.push({ level, code, message });
  const list = (m: Map<string, number>) => {
    const s = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return s.slice(0, 4).map(([k, n]) => `${k} (${n})`).join(', ') + (s.length > 4 ? '…' : '');
  };

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

  // Médias originaux (seuls ils décident du verdict) : les proxys et caches sont régénérables.
  if (originals.absent) {
    add('error', 'originals_absent',
      `${originals.absent} média(s) original(aux) sur ${originals.total} introuvable(s) : ni dans la bibliothèque, ni accessibles ici, ni à côté d'elle` +
      `${opts.neighbors ? '' : ' (dossier du projet non analysé)'}. Sources d'origine : ${list(absentSources)}. Sans eux, le projet n'est pas restaurable en entier.`);
  }
  if (originals.reachable) {
    add('warn', 'external_links', `${originals.reachable} média(s) original(aux) hors de la bibliothèque, accessibles ici pour l'instant (${list(new Map([...reachableSources].map(([k, v]) => [k, v.links])))}) : à sauvegarder avec le projet.`);
  }
  if (originals.neighborName) {
    add('warn', 'neighbor_name_only', `${originals.neighborName} média(s) original(aux) retrouvé(s) à côté de la bibliothèque seulement par leur NOM (source d'origine absente : taille non vérifiable).`);
  }
  if (originals.neighborExact) add('info', 'neighbor_found', `${originals.neighborExact} média(s) original(aux) retrouvé(s) dans le dossier du projet (même chemin).`);
  if (proxies.absent) add('info', 'proxies_absent', `${proxies.absent} proxy(s) / média(s) optimisé(s) absent(s) : régénérables par Final Cut à partir des originaux.`);
  if (!opts.neighbors && originals.total > originals.internal) add('info', 'no_neighbor_search', 'Dossier du projet non analysé (bibliothèque à la racine du disque) : les médias voisins n\'ont pas été recherchés.');
  if (opts.neighbors && !opts.neighbors.complete) add('warn', 'neighbor_truncated', 'Dossier du projet trop volumineux : la recherche des médias voisins est partielle.');
  if (zeroByteCount) add('warn', 'zero_byte_media', `${zeroByteCount} média(s) original(aux) de taille nulle (copie interrompue ?), ex. ${zeroByteMedia[0]}.`);
  if (unreadable) add('warn', 'unreadable', `${unreadable} élément(s) illisible(s) pendant l'inspection (ex. ${unreadablePath}) : le contenu mesuré est incomplet.`);
  if (hasLock) add('info', 'lock_files', 'Fichiers de verrou présents (.lock) : la bibliothèque était peut-être ouverte au moment de la copie. Ouvrez-la une fois dans Final Cut pour confirmer.');
  if (cacheLink !== undefined) {
    const foreign = cacheLink.startsWith('/') || /^[A-Za-z]:/.test(cacheLink); // chemin absolu = cache d'un autre ordinateur
    add('info', 'cache_link', foreign
      ? `.fcpcache pointe vers ${cacheLink} (cache d'un autre ordinateur) : inutile pour la restauration.`
      : '.fcpcache est un lien de cache sans valeur pour la restauration.');
  }
  if (cacheLinks) add('info', 'cache_links', `${cacheLinks} lien(s) vers des caches ou copies transitoires (__AsyncCopying, analyses) : sans valeur.`);
  if (otherLinks) add('info', 'other_links', `${otherLinks} lien(s) hors des dossiers de médias, non classés : ignorés pour le verdict.`);
  if (appleDouble) add('info', 'appledouble', `${appleDouble} fichier(s) ._* (métadonnées macOS) sans valeur.`);
  if (nested.length) add('info', 'nested_library', `${nested.length} autre(s) bibliothèque(s) imbriquée(s), comptée(s) comme projet(s) distinct(s).`);

  // Dépendances : sources des originaux NON retrouvés à côté (introuvables, ou accessibles ici mais hors de la bibliothèque).
  const depMap = new Map<string, { source: string; links: number; reachable: number }>();
  for (const [source, links] of absentSources) depMap.set(source, { source, links, reachable: 0 });
  for (const [source, r] of reachableSources) {
    const d = depMap.get(source) ?? { source, links: 0, reachable: 0 };
    d.links += r.links;
    d.reachable += r.links;
    depMap.set(source, d);
  }

  const report: FcpReport = {
    version: 1,
    totalBytes,
    totalFiles,
    categories,
    events: eventList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    symlinks,
    dependencies: [...depMap.values()].sort((a, b) => b.links - a.links),
    brokenLinks,
    warnings,
    nestedLibraries: nested,
    projectFolder: opts.projectFolder ?? null,
    lastEditMs: lastEditMs > 0 ? lastEditMs : null,
    originals,
    proxies,
    cacheLinks,
    missingOriginals: missing,
    mediaKeys: [...keys],
    mediaKeysTruncated: keysTruncated || undefined,
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
