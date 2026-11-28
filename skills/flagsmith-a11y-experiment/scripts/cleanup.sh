#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec npx tsx "$ROOT/scripts/skill-cleanup.ts" "$@"
