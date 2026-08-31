# dsh-imessage production roadmap status

Updated at commit following `c1f8837`.

## Completed

- Task 0: inventory and remove experimental `matrix`/`imessage` workloads.
- Task 1: stable backend, message, attribution, status, and error contracts.
- Task 2: removed the dead privileged `curl`/system-k3s scaffold; platform-isolated dynamic loading; serialized lifecycle; safe replacement rollback; clean unload; explicit profile → persisted setup → platform-default precedence.
- Task 3 foundation: versioned `setup.json`, atomic `0600` writes with directory fsync, setup lock and stale-lock recovery, transition validation, cancellation, failure recording, interrupted-step recovery, and read-only/operator tools.

## Task 3 remaining integration

- Runtime-specific setup executors must call `begin`, `complete`, `fail`, `cancel`, and `throwIfCancelled` as Tasks 4–5 are implemented.
- UI progress presentation and destructive reset confirmation remain Task 11.
- Credential and workload removal semantics remain runtime-specific; cancellation intentionally preserves completed work.

## Task 4 completed

- `IMessageRuntime` and `ClusterRuntime` contracts.
- Existing Kubernetes detection: kubeconfig, API, namespace/workload/Secret/ConfigMap/PVC RBAC, and StorageClass.
- Declarative explicit-manifest application, namespace-scoped removal, and bounded logs.
- External Matrix validation: versions, credential, room, media, search, and optional corten health.
- Rootless k3s placeholder refuses installation until pinned Task-5 artifacts exist.
- Runtime select/check tools update the durable setup transaction without hidden infrastructure changes.

## Next implementation order

1. Task 5: pinned, checksum-verified rootless k3s runtime.
4. Connect each executor to the persistent setup transaction boundary.

npm publication remains paused.

## Task 5 implementation slice

- Pinned k3s `v1.36.4+k3s1`, RootlessKit `v3.1.0`, and slirp4netns `v1.3.5` for Linux x64/arm64 with release SHA-256 values.
- Atomic `.partial` downloads, pre-install checksum verification, archive traversal rejection, `0700` executables, file/directory fsync, and last-known binary preservation on failure.
- Host checks for user namespaces, namespace limits, cgroup v2, memory, disk, and userspace-network fallback.
- User-owned paths under `~/.local/share/dsh-imessage`; direct `k3s server --rootless`; private logs, PID identity checks, graceful stop, readiness polling, and owned-state removal.
- Explicit `imessage_runtime_prepare`; ordinary plugin boot still performs no download, installation, or cluster launch.

Live rootless clean-room acceptance and systemd-user delegation coverage remain release gates; this commit does not claim those gates passed.

## Task 5 live acceptance result on escha

The full verified x64 runtime bundle downloaded and installed successfully in an isolated `/tmp` root. User-systemd unit rendering/install and `Delegate=yes` were exercised. Cluster launch was correctly classified as blocked on this host: Ubuntu AppArmor has `kernel.apparmor_restrict_unprivileged_userns=1`, and k3s fails its rootless child with `operation not permitted`. Detection now reports this before download/launch with an actionable existing-cluster/external-Matrix alternative. The temporary user service was disabled; no cluster remained running. This is an environmental acceptance block, not a reason for implicit privilege escalation.

## Tasks 6–7 implementation slice

- Added `flake.nix`, a generated `flake.lock` pinning nixpkgs revision `50ab793...`, x64/arm64 release derivations, and an immutable-asset check derivation.
- Added deterministic Matrix bundle rendering into a private `0700` directory with `0600` manifests, generated secrets, namespace substitution, unknown-token rejection, and bundle digest.
- Replaced experimental manifests containing `REPLACE_ME`, mutable image tags, and a fixed namespace.
- Pinned multi-architecture Postgres 16.4 and Synapse 1.115 OCI indexes by digest.
- Pinned corten-matrix 1.2.2 x64/arm64 release binaries by vendor-published SHA-256. Corten remains an activation-gated verified host process; no fictional OCI image or unconfigured pod is emitted.
- Added a package/release guard for placeholders, mutable images/URLs, unknown tokens, assets inclusion, and corten descriptor consistency.

Nix portable successfully generated the lock and `nix flake check --no-build` evaluated x86_64 derivations. The first check build exposed a dirty-tree source snapshot limitation before commit; the committed tree must be rebuilt as the next validation action. Reproducible double-build and arm64 Nix execution remain acceptance gates until both derivations can run in clean environments.
