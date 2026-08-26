# Controlled SAM acceptance and deployment profiles

These assets validate the integration against **sam-research's own binaries and
acceptance tests**. They do not vendor SAM, create an enrollment authority, or
pretend that a ready Pod proves the mesh datapath.

## Coverage and limits

| Requirement | Executable evidence | Limit |
|---|---|---|
| network-none agent → sam-box → sam-node | upstream `tests/e2e/agent_sandbox.bats` | requires Docker, Bats and `/dev/net/tun` |
| registration and two-node propagation | upstream `services.bats` and `find_remote_tools.bats` | container topology; DHT propagation is polled/observed upstream |
| labels / fail closed | focused upstream Go label tests; package live tests when `SAM_LIVE=1` | labels are any-of routing constraints, not general authorization |
| cancellation | local `TaskService` tests and upstream context-cancellation tests | task cancellation is the package protocol, not remote process killing |
| restart | K8s rollout smoke and VM systemd `Restart=on-failure` | preserves node identity only when its configured data directory is persistent |

Run:

```bash
acceptance/run.sh local       # safe default; unavailable optional layers skip
acceptance/run.sh two-node    # Docker-backed upstream tests
acceptance/run.sh k8s         # existing namespace/control-plane only
acceptance/run.sh all
```

A skip exits the individual probe with 77 and is summarized without hiding real
failures. `SAM_RESEARCH` selects the upstream checkout. Nothing downloads or
starts a control plane implicitly.

## Kubernetes

The manifest is a profile, not a turnkey SAM install. Set its variables and
render it only into a dedicated, existing namespace:

```bash
export SAM_ACCEPTANCE_NAMESPACE=sam-acceptance
# also set SAM_{SERVICE_ACCOUNT,NODE_IMAGE,BOX_IMAGE,NANO_INIT_IMAGE,AGENT_IMAGE,CONTROL_PLANE_URL}
envsubst < acceptance/k8s/deployment.yaml | kubectl apply -f -
acceptance/k8s/smoke.sh
```

The agent runs through `nano-init --create-namespaces`; it is not merely a curl
configured with a proxy. Kubernetes support for user/network namespaces,
`/dev/net/tun`, and the image's shell/curl are prerequisites. The reference
manifest intentionally contains no broad Internet egress allowlist and checks
that the node registration API returns 403 from the sandbox side. For a richer
canary (private resolver and workload credential verification), use
`sam-research/.github/k8s/sam-box-canary-template.yaml` from the matching SAM
revision.

Service registration belongs on a provider node's strict `sam-node.yaml`:

```yaml
version: v1alpha1
attenuation: {policies: [], checks: [], rules: []}
services:
- type: mcp
  name: calculator
  description: controlled acceptance service
  target_url: http://calculator:7777/mcp
```

Configuration parsing is strict. Provider labels are node/enrollment metadata,
not service-config fields in the pinned fixture. Configure them through the
matching sam-node/control-plane enrollment interface and verify them with that
revision’s `--help` and label tests; do not add an invented `labels` key here.
The upstream two-node fixture is the authoritative known-good service example.

## VM profile

Install binaries built from one pinned sam-research revision, copy the example
environment and unit, then use `systemd-analyze verify` before enabling. The
unit keeps the node API on a Unix socket and places the agent behind nano-init.
A real deployment should add a persistent node data directory (and the
corresponding sam-node flag from that exact binary's `--help`) before treating a
restart as identity-preserving. Verify cancellation with SIGTERM/systemctl stop:
`KillMode=control-group` terminates node, box and agent together.

## Controlled test procedure

1. Record package SHA, sam-research SHA, image digests and rendered config.
2. Run local/unit probes. Do not promote after skips unless the skipped property
   is explicitly out of scope.
3. Run the two-node suite in an isolated Docker host or namespace.
4. For cluster acceptance, install an already-enrolled control plane, deploy a
   caller and provider, poll discovery rather than sleeping a fixed duration,
   exercise correct and impossible labels, then restart the provider and poll
   discovery/invocation again.
5. Save stdout, container/Pod logs and the exact commands as evidence.

The supplied K8s smoke covers the sandbox boundary and caller restart only.
Provider restart, dynamic deregistration TTL, and cross-host partition recovery
are not claimed by these assets; use the corresponding upstream integration
suite or add environment-specific checks before asserting them.
