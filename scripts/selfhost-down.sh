#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" != "--yes-shared" ]]; then
  echo "refusing to down shared Flagsmith on :8000; pass --yes-shared" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker info failed. Start Docker as this user and retry. VM-only tip: if compose DNS fails, set net.bridge.bridge-nf-call-iptables=0 manually."
  exit 1
fi
ENV_FILE="$ROOT/selfhost/.env"
if [[ -f "$ENV_FILE" ]]; then
  docker compose -f "$ROOT/selfhost/docker-compose.yml" --env-file "$ENV_FILE" --project-name lift-selfhost down
else
  echo "selfhost/.env missing; compose down without --env-file"
  docker compose -f "$ROOT/selfhost/docker-compose.yml" --project-name lift-selfhost down || true
fi
