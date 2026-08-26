#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build >/dev/null
file="$(mktemp)"; rm -f "$file"
cleanup(){ [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true; rm -f "$file"; }; trap cleanup EXIT
ADDRESS_FILE="$file" node acceptance/task-service-server.mjs & pid=$!
for _ in {1..100}; do [[ -s "$file" ]] && break; sleep .05; done
[[ -s "$file" ]] || { echo 'task server did not start' >&2; exit 1; }
ADDRESS_FILE="$file" node acceptance/task-service-client.mjs
