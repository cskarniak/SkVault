#!/usr/bin/env bash
cd "$(dirname "$0")"
lsof -ti:3010 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:3011 2>/dev/null | xargs kill -9 2>/dev/null || true
docker compose -f docker/docker-compose.yml down
