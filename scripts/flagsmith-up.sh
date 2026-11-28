#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to self-host Flagsmith. Install docker and docker compose, then re-run."
  echo "Cloud: set FLAGSMITH_* env vars from app.flagsmith.com instead."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker info failed. Start Docker as this user and retry. VM-only tip: if compose DNS fails, set net.bridge.bridge-nf-call-iptables=0 manually."
  exit 1
fi

if [[ ! -f docker-compose.flagsmith.yml ]]; then
  echo "Fetching official Flagsmith docker-compose.yml"
  curl -fsSL https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml \
    -o docker-compose.flagsmith.yml
fi

docker compose -f docker-compose.flagsmith.yml up -d

echo "Waiting for Flagsmith at http://127.0.0.1:8000 ..."
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 \
    || curl -fsS http://127.0.0.1:8000/api/v1/ >/dev/null 2>&1 \
    || curl -fsS -o /dev/null -w '' http://127.0.0.1:8000 >/dev/null 2>&1; then
    echo "Flagsmith is up."
    echo "Create the first user in the dashboard (http://127.0.0.1:8000), then an org API token."
    echo "Put FLAGSMITH_ADMIN_API_TOKEN, FLAGSMITH_ENVIRONMENT_KEY, FLAGSMITH_SERVER_KEY, FLAGSMITH_PROJECT_ID in .env"
    echo "Enable Environment Settings > Warehouse > Flagsmith database, then npm run bootstrap."
    exit 0
  fi
  sleep 2
done

echo "Flagsmith did not become ready in time. Check: docker compose -f docker-compose.flagsmith.yml logs"
exit 1
