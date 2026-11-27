#!/usr/bin/env bash
# Start official Flagsmith compose OUTSIDE this repo, pinned to tag v2.295.2.
# Never put sysctl in this script. If migrate-db fails on a VM, run
# `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` yourself, then retry.
# No sudo in this script. No default bootstrap credentials.
set -euo pipefail

TAG="v2.295.2"
IMAGE="docker.flagsmith.com/flagsmith/flagsmith:2.295.2"
SCRATCH="${LIFT_FLAGSMITH_SCRATCH:-$HOME/.lift-flagsmith-2.295.2}"
mkdir -p "$SCRATCH"
cd "$SCRATCH"

if [[ ! -f .env ]]; then
  umask 077
  {
    echo "DJANGO_SECRET_KEY=$(openssl rand -hex 32)"
    echo "FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "DJANGO_ALLOWED_HOSTS=*"
  } > .env
fi

curl -fsSL -o docker-compose.yml \
  "https://raw.githubusercontent.com/Flagsmith/flagsmith/${TAG}/docker-compose.yml"

# Pin images even if the tagged compose still says :latest.
sed -i.bak \
  -e "s|flagsmith/flagsmith:latest|flagsmith/flagsmith:2.295.2|g" \
  -e "s|docker.flagsmith.com/flagsmith/flagsmith:latest|${IMAGE}|g" \
  -e "s|flagsmith/flagsmith:[0-9][^[:space:]\"]*|flagsmith/flagsmith:2.295.2|g" \
  -e "s|docker.flagsmith.com/flagsmith/flagsmith:[0-9][^[:space:]\"]*|${IMAGE}|g" \
  docker-compose.yml

python3 - "$SCRATCH" <<'PY'
from pathlib import Path
import sys
text = Path("docker-compose.yml").read_text()
text = text.replace("\"8000:8000\"", "\"127.0.0.1:8000:8000\"")
text = text.replace("- 8000:8000", "- 127.0.0.1:8000:8000")
text = text.replace("- \"8000:8000\"", "- \"127.0.0.1:8000:8000\"")
Path("docker-compose.yml").write_text(text)
PY

if ! docker info >/dev/null 2>&1; then
  echo "Cannot talk to the Docker daemon without sudo. Add this user to the docker group and retry."
  exit 1
fi

docker compose --env-file .env -f docker-compose.yml up -d

echo "Waiting for Flagsmith at http://127.0.0.1:8000 ..."
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 \
    || curl -fsS -o /dev/null -w '' http://127.0.0.1:8000 >/dev/null 2>&1; then
    echo "Flagsmith is up (scratch dir $SCRATCH, image ${IMAGE}, bound 127.0.0.1:8000)."
    echo "Bootstrap admin/org/project/env via the API, then set FLAGSMITH_* in the environment."
    echo "Do not commit tokens. Secrets live in $SCRATCH/.env (not printed)."
    exit 0
  fi
  sleep 2
done

echo "Flagsmith did not become ready. Check: docker compose -f $SCRATCH/docker-compose.yml logs"
exit 1
