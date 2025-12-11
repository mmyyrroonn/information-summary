#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo ">>> Building Docker images"
docker compose build

echo ">>> Running Prisma migrations inside the server container"
docker compose run --rm server npx prisma migrate deploy

echo ">>> Starting all services"
docker compose up -d

echo "All services are starting. Use 'docker compose logs -f' to follow logs."
