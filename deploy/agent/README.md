# Agent SkVault — installation sur une machine à scanner

L'agent tourne en veille sur chaque machine qui voit des disques (MacBook, vieux MacBook Linux, machine reliée à un NAS…).
Il interroge l'API toutes les 3 s et exécute les scans demandés depuis l'onglet **Scans** de l'interface web.
Il n'ouvre aucun port : seule la machine appelle le serveur. Lecture seule.

## Prérequis
Node ≥ 20 et pnpm (`corepack enable`), accès réseau à `https://skvault.home` (LAN ou Tailscale).

## Installation
```bash
git clone https://github.com/cskarniak/SkVault.git && cd SkVault
pnpm install --filter agent... && pnpm --filter @skvault/shared build
```
Jeton : `ssh skbox-mini 'grep AGENT_TOKEN ~/apps/SkVault/.env'`

Test à la main : `SKVAULT_URL=https://skvault.home/api SKVAULT_AGENT_TOKEN=… pnpm agent run`
→ la machine apparaît « en ligne » dans l'onglet Scans.

HTTPS avec le certificat mkcert : sur chaque machine, `NODE_EXTRA_CA_CERTS=/chemin/rootCA.pem`
(copier `rootCA.pem` depuis `~/Library/Application Support/mkcert/` du Mac principal — **jamais** `rootCA-key.pem`).

## Démarrage automatique
- **macOS** : `com.skvault.agent.plist` → `~/Library/LaunchAgents/`, puis `launchctl load ~/Library/LaunchAgents/com.skvault.agent.plist`
- **Linux** : `skvault-agent.service` (instructions en tête du fichier). `~/.config/skvault-agent.env` :
  ```
  SKVAULT_URL=https://skvault.home/api
  SKVAULT_AGENT_TOKEN=…
  NODE_EXTRA_CA_CERTS=/home/<vous>/rootCA.pem
  ```

## Dossiers autorisés
Par sécurité, l'agent refuse tout scan hors de : dossier personnel, `/Volumes`, `/mnt`, `/media`, `/run/media`.
Pour changer : `SKVAULT_ALLOWED_ROOTS=/srv/nas:/data` (ou `--allow`). Le nom de machine est le hostname (`--host` pour le forcer).
