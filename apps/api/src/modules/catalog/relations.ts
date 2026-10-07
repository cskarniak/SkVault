/**
 * Relations entre bibliothèques Final Cut : réplique, version contenue dans une autre, recoupement partiel, complément.
 * Comparaison sur les empreintes des médias ORIGINAUX (`mediaKeys` du rapport) ; la plus récente se juge à la date des bases.
 */
export interface LibraryInfo {
  id: string;
  volumeId: string;
  projectFolder: string | null;
  lastEditMs: number | null;
  keys: Set<string>;
}

export type RelationKind = 'replica' | 'contained' | 'overlap' | 'complement';

export interface Relation {
  kind: RelationKind;
  inter: number;
  /** part des médias de A retrouvés dans B, et inversement */
  coverA: number;
  coverB: number;
  jaccard: number;
  /** pour `contained` : quelle bibliothèque en contient une autre ('a' contient b, ou 'b' contient a) */
  container?: 'a' | 'b';
  /** la plus récente d'après la dernière modification des bases (null si indéterminée ou à moins d'une minute) */
  newer: 'a' | 'b' | null;
  sameFolder: boolean;
}

/** Réplique : chaque bibliothèque est retrouvée à ≥ 99 % dans l'autre. Contenue : l'une est retrouvée à ≥ 95 % dans l'autre, qui a davantage. */
const REPLICA = 0.99;
const CONTAINED = 0.95;
const OVERLAP = 0.2;

export function compareLibraries(a: LibraryInfo, b: LibraryInfo): Relation | null {
  if (a.keys.size === 0 || b.keys.size === 0) return null;
  let inter = 0;
  const [small, big] = a.keys.size <= b.keys.size ? [a.keys, b.keys] : [b.keys, a.keys];
  for (const k of small) if (big.has(k)) inter++;
  const coverA = inter / a.keys.size;
  const coverB = inter / b.keys.size;
  const jaccard = inter / (a.keys.size + b.keys.size - inter);
  const sameFolder = a.volumeId === b.volumeId && a.projectFolder !== null && a.projectFolder === b.projectFolder;

  let kind: RelationKind | null = null;
  let container: 'a' | 'b' | undefined;
  if (coverA >= REPLICA && coverB >= REPLICA) kind = 'replica';
  else if (coverA >= CONTAINED && coverA >= coverB) { kind = 'contained'; container = 'b'; } // A est (presque) toute dans B, qui a davantage
  else if (coverB >= CONTAINED) { kind = 'contained'; container = 'a'; }
  else if (jaccard >= OVERLAP) kind = 'overlap';
  else if (sameFolder) kind = 'complement'; // même dossier de projet, médias distincts
  if (!kind) return null;

  let newer: 'a' | 'b' | null = null;
  if (a.lastEditMs != null && b.lastEditMs != null && Math.abs(a.lastEditMs - b.lastEditMs) > 60_000) newer = a.lastEditMs > b.lastEditMs ? 'a' : 'b';
  return { kind, inter, coverA, coverB, jaccard, container, newer, sameFolder };
}
