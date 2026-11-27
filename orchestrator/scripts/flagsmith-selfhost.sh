#!/usr/bin/env bash
# Start official Flagsmith compose OUTSIDE this repo, pinned to 2.295.2.
# Never put sysctl in this script. If migrate-db fails on a VM, run
# `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` yourself, then retry.
set -euo pipefail

SCRATCH="${LIFT_FLAGSMITH_SCRATCH:-$HOME/.lift-flagsmith-2.295.2}"
mkdir -p "$SCRATCH"
cd "$SCRATCH"

if [[ ! -f docker-compose.yml ]]; then
  curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml
fi

sed -i.bak \
  -e 's|flagsmith/flagsmith:latest|flagsmith/flagsmith:2.295.2|g' \
  -e 's|docker.flagsmith.com/flagsmith/flagsmith:latest|docker.flagsmith.com/flagsmith/flagsmith:2.295.2|g' \
  docker-compose.yml

if docker info >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif sudo docker info >/dev/null 2>&1; then
  compose() { sudo docker compose "$@"; }
else
  echo "Cannot talk to the Docker daemon."
  exit 1
fi

compose -f docker-compose.yml up -d

echo "Waiting for Flagsmith at http://127.0.0.1:8000 ..."
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 \
    || curl -fsS -o /dev/null -w '' http://127.0.0.1:8000 >/dev/null 2>&1; then
    echo "Flagsmith is up (scratch dir $SCRATCH)."
    echo "Bootstrap admin/org/project/env via the API, then set FLAGSMITH_* in the environment."
    echo "Do not commit tokens."
    exit 0
  fi
  sleep 2
done

echo "Flagsmith did not become ready. Check: docker compose -f $SCRATCH/docker-compose.yml logs"
exit 1
