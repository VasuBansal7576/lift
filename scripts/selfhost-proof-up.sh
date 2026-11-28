#!/usr/bin/env bash
# Cold-start a SEPARATE Flagsmith compose project for the T3 recording.
# Never stops or downs the shared lift-selfhost stack on 127.0.0.1:8000.
set -euo pipefail
if [[ -z "${LIFT_STDBUF:-}" && ! -t 1 ]]; then
  export LIFT_STDBUF=1
  exec stdbuf -oL -eL bash "$0" "$@"
fi
if [[ -z "${LIFT_PROOF_UP_TEE:-}" ]]; then
  export LIFT_PROOF_UP_TEE=1
  exec > >(tee /tmp/lift-proof-up.log)
  exec 2>&1
fi
cd "$(dirname "$0")/.."

PROJECT="${COMPOSE_PROJECT_NAME:-lift-selfhost-proof}"
PORT="${FLAGSMITH_HTTP_PORT:-8010}"

if [[ "$PROJECT" == "lift-selfhost" ]]; then
  echo "refusing COMPOSE_PROJECT_NAME=lift-selfhost (shared stack on :8000)" >&2
  exit 1
fi
if [[ "$PROJECT" != *-proof ]]; then
  echo "COMPOSE_PROJECT_NAME must end with -proof (got ${PROJECT})" >&2
  exit 1
fi
if [[ "$PORT" == "8000" ]]; then
  echo "refusing FLAGSMITH_HTTP_PORT=8000 (shared stack)" >&2
  exit 1
fi

if [[ "${LIFT_PROOF_UP_CHECK:-}" == "1" ]]; then
  echo "would down -v then up project=${PROJECT} port=${PORT}"
  exit 0
fi

rm -f /tmp/lift-proof-up.done
touch /tmp/lift-proof-up.started

ORIGIN="http://127.0.0.1:${PORT}"
export COMPOSE_MENU=0
export FLAGSMITH_HTTP_PORT="$PORT"
export COMPOSE_PROJECT_NAME="$PROJECT"

COMPOSE=(
  docker compose
  -f selfhost/docker-compose.yml
  -f selfhost/docker-compose.proof.yml
  --env-file selfhost/.env
  --project-name "$PROJECT"
  --progress plain
)

echo "==> compose project=${PROJECT} host=${ORIGIN}"
echo "==> shared lift-selfhost:8000 is not touched"
echo "==> down -v (proof project only), then postgres + migrate-db -d + flagsmith up -d"
echo "==> migrate-db logs are never shown"

poll() {
  local i=0
  while true; do
    i=$((i + 1))
    local code http_code
    code=$(curl -sS -o /tmp/lift-proof-health.body -w '%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s' "${ORIGIN}/health/liveness/" 2>/dev/null || echo '000 dns=0s connect=0s ttfb=0s total=0s')
    http_code="${code%% *}"
    printf '\rhealth-poll %d liveness HTTP %s %s' "$i" "$code" "${ORIGIN}/health/liveness/"
    if [ "$http_code" = "200" ]; then
      printf '\n'
      echo "body: $(tr -d '\n' </tmp/lift-proof-health.body)"
      echo "==> version"
      curl -sS "${ORIGIN}/version/" || true
      echo
      return 0
    fi
    if [ "$i" -ge 90 ]; then
      printf '\n'
      echo "health timeout after ${i} polls"
      return 1
    fi
    sleep 1
  done
}

"${COMPOSE[@]}" down -v --remove-orphans || true

poll &
POLL_PID=$!

"${COMPOSE[@]}" up -d postgres
"${COMPOSE[@]}" up -d migrate-db
migrate_name="${PROJECT}-migrate-db-1"
for _ in $(seq 1 120); do
  status=$(docker inspect -f '{{.State.Status}}' "$migrate_name" 2>/dev/null || echo missing)
  if [[ "$status" == "exited" ]]; then
    code=$(docker inspect -f '{{.State.ExitCode}}' "$migrate_name" 2>/dev/null || echo 1)
    if [[ "$code" != "0" ]]; then
      echo "migrate-db exited ${code}" >&2
      kill "$POLL_PID" 2>/dev/null || true
      exit 1
    fi
    break
  fi
  if [[ "$status" == "missing" ]]; then
    break
  fi
  sleep 1
done
"${COMPOSE[@]}" up -d

wait "$POLL_PID"

echo "==> bootstrap ${ORIGIN} (writes selfhost/.env.proof only; no leftover SDK keys)"
FLAGSMITH_PROOF_ORIGIN="$ORIGIN" npx tsx scripts/selfhost-proof-bootstrap.ts
echo "==> proof stack ready at ${ORIGIN}"
touch /tmp/lift-proof-up.done
