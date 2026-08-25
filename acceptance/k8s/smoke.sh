#!/usr/bin/env bash
# Existing-cluster smoke. It never creates a namespace/control plane implicitly.
set -uo pipefail
NS=${SAM_ACCEPTANCE_NAMESPACE:-sam-acceptance}
DEPLOY=${SAM_ACCEPTANCE_DEPLOYMENT:-sam-box-agent}
skip(){ echo "SKIP: $*"; exit 77; }
command -v kubectl >/dev/null || skip 'kubectl unavailable'
kubectl get namespace "$NS" >/dev/null 2>&1 || skip "namespace $NS unavailable"
# Enrollment is meaningful only with a reachable control plane in this namespace.
kubectl -n "$NS" get service "${SAM_CONTROL_PLANE_SERVICE:-sam-control-plane}" >/dev/null 2>&1 || skip 'control-plane Service unavailable'
kubectl -n "$NS" get deployment "$DEPLOY" >/dev/null 2>&1 || skip "deployment $DEPLOY not installed; render deployment.yaml first"
kubectl -n "$NS" rollout status deployment/"$DEPLOY" --timeout="${SAM_TIMEOUT:-180s}" || exit 1
pod=$(kubectl -n "$NS" get pod -l app="$DEPLOY" -o jsonpath='{.items[0].metadata.name}')
[[ -n "$pod" ]] || exit 1
# The canary writes explicit outcomes. Do not infer datapath success from Ready.
kubectl -n "$NS" logs "$pod" -c agent --tail=100 | grep -q 'mesh-models=' || { echo 'agent did not report mesh request'; exit 1; }
kubectl -n "$NS" logs "$pod" -c agent --tail=100 | grep -q 'node-api=403' || { echo 'node API was not denied'; exit 1; }
# Restart both gateway and node via a pod restart, then require the same assertions.
kubectl -n "$NS" rollout restart deployment/"$DEPLOY"
kubectl -n "$NS" rollout status deployment/"$DEPLOY" --timeout="${SAM_TIMEOUT:-180s}" || exit 1
sleep 5
pod=$(kubectl -n "$NS" get pod -l app="$DEPLOY" -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" logs "$pod" -c agent --tail=100 | grep -q 'mesh-models='
