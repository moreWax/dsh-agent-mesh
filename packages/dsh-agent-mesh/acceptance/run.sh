#!/usr/bin/env bash
# Controlled acceptance entry point. Optional infrastructure checks return 77 (skip).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SAM_RESEARCH=${SAM_RESEARCH:-/home/xor/ds/sam-research}
MODE=${1:-local}
pass=0; skip=0; fail=0
run() { local name=$1; shift; printf '\n== %s ==\n' "$name"; "$@"; local rc=$?; case $rc in 0) pass=$((pass+1));; 77) echo "SKIP: $name"; skip=$((skip+1));; *) echo "FAIL($rc): $name"; fail=$((fail+1));; esac; }
require_upstream() { [[ -d "$SAM_RESEARCH" ]] || { echo "sam-research absent: $SAM_RESEARCH"; return 77; }; }
unit() { cd "$ROOT" && pnpm test -- tests/task-service.test.ts tests/tools.test.ts tests/inference.test.ts; }
upstream_go() { require_upstream || return $?; command -v go >/dev/null || return 77; cd "$SAM_RESEARCH" && go test ./internal/sambox ./internal/node -run 'Test.*(Label|ServiceRegistry|Cancel|Restart|Reprovide)' -count=1; }
container() {
  require_upstream || return $?; command -v docker >/dev/null || return 77
  docker info >/dev/null 2>&1 || { echo 'docker daemon unavailable'; return 77; }
  command -v bats >/dev/null || { echo 'bats unavailable'; return 77; }
  [[ -e /dev/net/tun ]] || { echo '/dev/net/tun unavailable (network-none test cannot run)'; return 77; }
  cd "$SAM_RESEARCH" || return
  # These are upstream-owned executable acceptance tests, not copies. The first
  # proves agent(--network none)->sam-box(UDS)->sam-node and API denial; the
  # others prove service registration, DHT propagation and remote invocation.
  bats tests/e2e/agent_sandbox.bats tests/e2e/services.bats tests/e2e/find_remote_tools.bats
}
k8s() { "$ROOT/acceptance/k8s/smoke.sh"; }
case "$MODE" in
 local) run 'task cancellation and client semantics' unit; run 'sam-box/registry/label focused Go tests' upstream_go; run 'network-none and two-node container mesh' container;;
 two-node) run 'network-none and two-node container mesh' container;;
 k8s) run 'Kubernetes sam-box restart smoke' k8s;;
 all) run 'task cancellation and client semantics' unit; run 'sam-box/registry/label focused Go tests' upstream_go; run 'network-none and two-node container mesh' container; run 'Kubernetes sam-box restart smoke' k8s;;
 *) echo "usage: $0 {local|two-node|k8s|all}" >&2; exit 2;;
esac
printf '\nsummary: %d passed, %d skipped, %d failed\n' "$pass" "$skip" "$fail"
(( fail == 0 ))
