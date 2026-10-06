#!/bin/bash
# Redéploiement de SkVault sur skbox-mini après un rsync (voir deploy/README.md).
# Usage : ssh skbox-mini 'cd ~/apps/SkVault && bash deploy/deploy.sh'
set -euo pipefail
cd /home/christian/apps/SkVault

pnpm install
pnpm build:packages
pnpm db:generate
pnpm db:deploy
NEXT_PUBLIC_API_URL="$(grep NEXT_PUBLIC_API_URL .env | cut -d= -f2- | tr -d '"')" pnpm build
sudo systemctl restart skvault-api skvault-web
# L'agent du serveur (scan du NAS) exécute le code du dépôt : à relancer pour prendre la nouvelle version
if systemctl cat skvault-agent >/dev/null 2>&1; then sudo systemctl restart skvault-agent; fi
systemctl is-active skvault-api skvault-web skvault-agent || true
