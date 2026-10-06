#!/bin/bash
# Première installation de SkVault sur skbox-mini — étapes qui exigent le mot de passe sudo.
# À lancer UNE fois, sur skbox-mini, après le rsync du code et la création de ~/apps/SkVault/.env :
#   ssh -t skbox-mini 'bash ~/apps/SkVault/deploy/first-install.sh'
# Idempotent. Ne démarre rien (le build n'est pas encore fait) : voir deploy/README.md pour la suite.
set -euo pipefail
APP=/home/christian/apps/SkVault
ENV="$APP/.env"

# Mot de passe et URL de la base lus dans le .env distant (jamais écrits ailleurs)
DB_URL="$(grep '^DATABASE_URL=' "$ENV" | cut -d= -f2- | tr -d '"')"
DB_PASS="$(echo "$DB_URL" | sed -E 's#^postgresql://skvault:([^@]+)@.*#\1#')"
[ -n "$DB_PASS" ] && [ "$DB_PASS" != "$DB_URL" ] || { echo "DATABASE_URL inattendue dans $ENV"; exit 1; }

echo "1. Base PostgreSQL (rôle + base skvault)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$DB_PASS" <<'SQL'
SELECT 'CREATE ROLE skvault LOGIN PASSWORD ' || quote_literal(:'pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'skvault') \gexec
SELECT 'CREATE DATABASE skvault OWNER skvault'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'skvault') \gexec
SQL

echo "2. Unités systemd"
sudo install -m 0644 "$APP/deploy/skvault-api.service" /etc/systemd/system/skvault-api.service
sudo install -m 0644 "$APP/deploy/skvault-web.service" /etc/systemd/system/skvault-web.service
sudo systemctl daemon-reload
sudo systemctl enable skvault-api skvault-web

echo "3. Sudoers (restart/status des services SkVault sans mot de passe)"
sudo install -m 0440 "$APP/deploy/skvault-sudoers" /etc/sudoers.d/skvault.new
sudo visudo -cf /etc/sudoers.d/skvault.new
sudo mv /etc/sudoers.d/skvault.new /etc/sudoers.d/skvault

if [ -f /tmp/skbox-admin-sudoers.new ]; then
  echo "4. Page Administration : sudoers + redémarrage de son API"
  sudo install -m 0440 /tmp/skbox-admin-sudoers.new /etc/sudoers.d/skbox-admin.new
  sudo visudo -cf /etc/sudoers.d/skbox-admin.new
  sudo mv /etc/sudoers.d/skbox-admin.new /etc/sudoers.d/skbox-admin
  rm /tmp/skbox-admin-sudoers.new
  sudo systemctl restart skbox-admin-api
fi
echo "OK — prévenez Claude : build, migrations et démarrage peuvent suivre."
