#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "🐳  Vérification de Docker..."
if ! docker info &>/dev/null; then
  open -a Docker
  echo -n "   Attente de Docker"
  until docker info &>/dev/null 2>&1; do echo -n "."; sleep 2; done
  echo " prêt."
fi

lsof -ti:3010 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:3011 2>/dev/null | xargs kill -9 2>/dev/null || true

docker compose -f docker/docker-compose.yml up -d
echo -n "   Attente de PostgreSQL"
until docker exec skvault-postgres pg_isready -U skvault -d skvault &>/dev/null 2>&1; do echo -n "."; sleep 1; done
echo " prêt."

pnpm db:deploy 2>/dev/null || echo "   (aucune migration à appliquer)"

echo "SkVault → http://localhost:3010   API → http://localhost:3011/api   Swagger → /api/docs"
pnpm dev
