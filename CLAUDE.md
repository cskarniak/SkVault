# SkVault — catalogue des disques

Inventaire de tout ce qui se trouve sur les disques de Christian (photos, sauvegardes, stockage) : savoir *où est quoi*,
rechercher un fichier tous disques confondus, repérer et dédoublonner. Accessible depuis le menu principal `apps.home`
(tuile « SkVault » → https://skvault.home). Remplace à terme les scripts Python de `~/Documents/dev/dedup/`.

## Stack (mêmes choix que SkGest)
- Monorepo pnpm : `apps/web` (Next.js 16 + Mantine 7 + TanStack Query), `apps/api` (NestJS 11 + Prisma 6 + PostgreSQL),
  `apps/agent` (CLI Node de scan), `packages/db` (Prisma), `packages/shared` (Zod + enums partagés)
- PostgreSQL (millions de lignes + requêtes de doublons : pas SQLite). Docker en local (port **5434**), natif sur skbox-mini.
- Ports : web **3010**, API **3011** (en local comme sur skbox-mini)

## Commandes
```bash
cp .env.example .env && pnpm install && pnpm docker:up
ln -s ../../.env packages/db/.env      # Prisma lit son .env dans packages/db
pnpm db:migrate && pnpm dev            # ou ./start.sh
pnpm typecheck
pnpm agent scan /Volumes/MonDisque --label "SSD Photos" --kind ssd   # env : SKVAULT_URL, SKVAULT_AGENT_TOKEN
```

## Architecture : API centrale + agents
Les disques sont répartis sur plusieurs machines (MacBook, NAS, DAS, SSD externes, deux vieux MacBook sous Linux) :
l'API centrale ne lit jamais les disques. Un **agent** (`apps/agent`) tourne sur chaque machine, en lecture seule, et
pousse le catalogue via `/api/ingest/scans/*` (authentifié par le jeton partagé `AGENT_TOKEN`, header `x-agent-token`).

Protocole d'un scan : `start` → `files` (lots de 2000, upsert) → `pending-hashes` ⇄ `hashes` → `finish`.
- `quick_hash` (SHA-1 de taille + 64 Ko début + 64 Ko fin) calculé pour tous les fichiers.
- `hash` (SHA-256 complet) calculé **uniquement** pour les fichiers ayant un homonyme (même taille + quick_hash) ailleurs
  dans le catalogue — évite de relire des To. Remis à NULL si taille ou date changent.
- `finish` supprime du catalogue les fichiers non revus par ce scan (effacés/déplacés).
- Conséquence : le premier volume scanné n'a pas de hash tant qu'un second volume ne contient pas d'homonyme ; **re-scanner
  le premier volume** après le second pour compléter les hash (rapide : seuls les candidats sont relus).

Un volume = (machine, chemin racine). Types : internal, ssd, das, nas, backup, other.
Auth utilisateur : JWT, le tout premier compte se crée depuis `/login` puis l'inscription est fermée.
L'interface ne supprime jamais de fichiers (consultation + recherche + doublons) ; « Retirer un volume » n'enlève que le catalogue.

## Import de l'ancien index `dedup/dedup.sqlite`
`pnpm agent import-dedup ~/Documents/dev/dedup/dedup.sqlite [--kind nas] [--skip-doublons]` — lit le fichier SQLite en
lecture seule (via le binaire `sqlite3`), sans relire les disques ; un volume par `dir_root` (`/Volumes/photo_bbl`,
`/Volumes/photos_a_classer`), sous le hostname de la machine (le même que l'agent, pour qu'un scan ultérieur retombe sur
le même volume). Idempotent. Vérifié : 48 405 fichiers, 4 004 groupes de doublons, 41,5 Go récupérables = ancien outil.
- Les anciennes empreintes **ne sont pas** mélangées aux nouvelles : `quick_hash` de l'ancien outil (MD5 des 4 premiers Ko)
  est ignoré ; son `md5` complet (28 % des fichiers) va dans la colonne `md5`, distincte de `hash` (SHA-256). Clé de
  doublon = `COALESCE(hash, 'md5:' || md5)` : un MD5 n'est jamais comparé à un SHA-256.
- Au prochain vrai scan d'un volume importé, taille+date inchangées ⇒ le MD5 est conservé, SkVault calcule ses propres
  empreintes, et les anciens MD5 sont dépassés peu à peu.
- `--skip-doublons` écarte les 4 494 fichiers rangés dans des dossiers `doublons/` par l'ancien outil (qui les excluait de
  ses rapports) ; par défaut ils sont importés car ils occupent toujours de la place.
- Le « dernier scan » d'un volume importé affiche la date de l'import, pas celle de l'ancien scan.

## Reste à faire (idées)
- Agent en service (launchd sur macOS / systemd sur Linux) + scans planifiés ; vieux MacBooks : vérifier Node ≥ 20
- Agents HTTPS : le certificat `skapps.pem` est auto-signé → `NODE_EXTRA_CA_CERTS=...` sur les machines agents
- Actions sur doublons (marquer/déplacer), vue arborescente par volume, détection de photos par date EXIF
- Déploiement : voir `deploy/README.md` (jamais sans accord explicite)
