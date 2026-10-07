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

## Types de scan (fixés par volume)
Deux types, **jamais mélangés sur un même volume** (`volumes.scan_mode`, mémorisé : « Rescanner » le réutilise sans rien redemander) :
- **`duplicates`** : inventaire de tous les fichiers + détection de doublons (comportement historique, `file_entries`). Les photothèques
  iPhoto/Photos (`*.photolibrary`, `*.photoslibrary`) sont **repérées mais non scannées** (le même fichier peut y exister plusieurs fois :
  versions retouchées) : une ligne `projects` de type `photo_library`, traitement dédié à venir.
- **`fcp_archive`** : aucun fichier catalogué ni haché ; les bibliothèques Final Cut sont repérées et inspectées, **une ligne par projet**
  (`projects`, type `fcp_library`) avec verdict + rapport (JSON `FcpReport`). Onglet **Projets**.
Changer le type d'un volume exige une confirmation (API : 409 `MODE_CHANGE` avec les effectifs ; web : fenêtre de confirmation ; CLI :
`--force-mode-change`) et **supprime les données de l'ancien type**. Le type est obligatoire dans le formulaire pour un nouveau volume.
Chaque volume porte aussi une **note** et un **emplacement physique** (« tiroir du bureau »), modifiables depuis la Vue d'ensemble.

### Inspection des bibliothèques Final Cut (`apps/agent/src/fcp.ts`)
- Détection par **fichier signature** `CurrentVersion.flexolibrary` OU extension `.fcpbundle` : sur un disque formaté Windows le paquet perd
  son statut de bundle, et une bibliothèque peut occuper la racine du disque (observé sur `sav_EMMA`). Recherche en dossiers seulement,
  profondeur 6, corbeille Windows et dossiers système ignorés. Une bibliothèque imbriquée devient un projet distinct.
- Métadonnées seules (`lstat`), aucun contenu lu, aucun lien suivi. Catégories : médias originaux, transcodés, rendus, analyses, fichiers de
  bibliothèque, modèles Motion, caches/temporaires/verrous/`._*`/corbeille, autres. « Inutile » : caches ; « régénérable » : rendus + analyses ;
  « conditionnel » : transcodés (si les originaux sont présents) ; jamais les médias originaux. **Rien n'est jamais supprimé.**
- **Médias « laissés sur place »** : Final Cut crée dans `Original Media` des liens symboliques vers des fichiers hors bibliothèque (autres disques,
  autre ordinateur). Un lien dont la cible est HORS de la bibliothèque est une *dépendance externe* (regroupée par source : `/Volumes/NEW`,
  `/Users/emma`…), pas un lien « cassé » ; « cassé » = cible DANS la bibliothèque et disparue.
- Verdict (un seul niveau de gravité par avertissement) : `incomplete` si erreur (fichier de bibliothèque absent, événement sans
  `CurrentVersion.fcpevent`, lien interne cassé, **dépendances externes introuvables depuis la machine qui scanne**) ; `to_check` si
  avertissement (dépendances externes accessibles, média de taille nulle, élément illisible, aucun événement…) ; `complete` sinon.
  Les infos (verrous `.lock`, `.fcpcache` vers un autre ordinateur, `._*`) n'ont pas d'effet sur le verdict.
- **Limite assumée** : les bases `.flexolibrary`/`.fcpevent` sont des SQLite Core Data opaques (aucune table de médias lisible) : SkVault ne
  peut pas savoir quels médias le projet *réclame*. « Complet » = structure correcte, aucun lien cassé, aucune dépendance externe manquante ;
  seul Final Cut garantit l'ouverture. Plugins tiers et polices ne sont pas dans la bibliothèque.
- Piste suivante : recouper les dépendances externes avec le catalogue (le média existe-t-il sur un autre volume scanné ?), et la comparaison
  de deux copies d'un même projet.

## Scans lancés depuis le web (démon d'agent)
`pnpm agent run` : l'agent reste en veille et **interroge** l'API (`/api/ingest/agent/*` : hello → heartbeat 10 s → poll 3 s →
progress → finish) ; aucun port ouvert sur les machines scannées. L'onglet **Scans** crée des `ScanJob` (table `scan_jobs`)
adressés à une machine ; l'agent de cette machine les réserve atomiquement (`FOR UPDATE SKIP LOCKED`), exécute le scan existant
et remonte la progression ; l'annulation est transmise à la remontée suivante (≤ 2 s). Bouton « Rescanner » sur chaque volume.
- Machine « en ligne » = heartbeat < 30 s. Un job pour une machine hors ligne reste en attente jusqu'à son retour.
- Au démarrage, l'agent déclare « échoué » les jobs « running » orphelins de sa machine (crash/redémarrage).
- Sécurité : l'agent refuse tout chemin hors des dossiers autorisés (`SKVAULT_ALLOWED_ROOTS`, défaut : $HOME, /Volumes, /mnt,
  /media, /run/media ; liens symboliques résolus). Scan annulé/échoué : le `ScanRun` passe en `failed`, rien n'est purgé.
- Installation de l'agent sur une machine + démarrage automatique : `deploy/agent/README.md` (launchd / systemd).

### Windows
`install.ps1` (modèle `apps/api/assets/install-agent.ps1`, servi avec un BOM UTF-8) : commande PowerShell affichée dans l'onglet Windows
(`curl.exe -k … -o %TEMP%\skvault-install.ps1` puis `powershell -File …` ; `… uninstall` pour désinstaller). **Sans droits administrateur** :
lanceur `~\.skvault-agent\start-agent.ps1` (relance l'agent s'il s'arrête, journal tronqué à 5 Mo) démarré par la clé
`HKCU\…\Run` ; dossier protégé par icacls (il contient le jeton). Chemins acceptés : `D:\…`, `C:/…`, `\\NAS\partage`.
Dossiers autorisés par défaut sous Windows : dossier personnel + lecteurs présents ; `SKVAULT_ALLOWED_ROOTS` se sépare par `;` ou `,`.
**Le script PowerShell n'a pas pu être exécuté lors du développement (aucun Windows/PowerShell disponible)** : seuls sa génération, sa
structure et le côté agent (comparaison de chemins Windows, simulée) ont été testés. À valider sur une vraie machine avec
`$env:SKVAULT_INSTALL_DRY_RUN=1` d'abord. Windows 10/11 requis (Node 20, `curl.exe` fourni avec Windows).

### Installer un agent depuis le web (« Ajouter une machine »)
Un site web ne peut pas s'installer seul sur une autre machine : l'onglet Scans génère une **commande à coller une fois** :
`curl -fsSk "https://skvault.home/api/agent-install/<code>/install.sh" | bash`.
- `POST /api/agent-enrollments` (JWT) crée un code aléatoire valable **1 h** (table `agent_enrollments`, nom de machine facultatif).
  Les routes `GET /api/agent-install/:code/{install.sh,agent.js,rootCA.pem}` sont publiques mais protégées par ce code.
- `install.sh` (modèle : `apps/api/assets/install-agent.sh`, jeton/origine/code injectés par l'API) vérifie Node ≥ 20, télécharge
  l'agent, écrit la config (chmod 600) et installe le démarrage automatique : LaunchAgent `com.skvault.agent` (macOS) ou service
  systemd utilisateur `skvault-agent` (Linux). Idempotent (relancer = mise à jour). `… | bash -s -- uninstall` désinstalle.
  `SKVAULT_INSTALL_DRY_RUN=1` affiche les actions sans rien installer (utilisé pour les tests).
- L'agent est servi comme **un seul fichier** `apps/agent/dist/agent.js` (`pnpm --filter agent bundle`, inclus dans `pnpm build`) :
  seul Node ≥ 20 est requis sur la machine, ni pnpm ni dépôt.
- HTTPS : le script est récupéré avec `curl -k` (la machine ne connaît pas encore l'autorité mkcert) ; si `ROOT_CA_FILE` (chemin du
  `rootCA.pem` **public**, jamais `rootCA-key.pem`) est défini côté serveur, il est installé sur la machine et l'agent vérifie
  ensuite normalement le certificat (`NODE_EXTRA_CA_CERTS`).
- Limite actuelle : un seul jeton d'agent partagé (`AGENT_TOKEN`) pour toutes les machines — pas de jeton par machine ni de révocation.
- Les entrées invalides (schémas Zod) renvoient 400 avec un message lisible (`common/zod-exception.filter.ts`).

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
- **Recherche (demandé le 2026-10-07, pour le lendemain)** : saisir une chaîne + choisir un opérateur « contient / commence par / finit par »
  (aujourd'hui : « contient » uniquement, sur le chemin complet, `catalog.service.ts` → `search`). Points à trancher : porter sur le nom du
  fichier ou le chemin complet (proposition : nom par défaut, option « chemin »), insensible à la casse (proposition : oui), échapper `%` `_` `\`.
- Scans planifiés (cron côté API) ; vieux MacBooks : vérifier Node ≥ 20
- Agents HTTPS : le certificat `skapps.pem` est auto-signé → `NODE_EXTRA_CA_CERTS=...` sur les machines agents
- Actions sur doublons (marquer/déplacer), vue arborescente par volume, détection de photos par date EXIF
- Déploiement : voir `deploy/README.md` (jamais sans accord explicite)
