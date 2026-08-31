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
