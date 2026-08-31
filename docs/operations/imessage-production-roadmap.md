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

## Next implementation order

1. Task 4: `ClusterRuntime` contract and three runtime choices.
2. Existing Kubernetes capability detection and external Matrix validation.
3. Task 5: pinned, checksum-verified rootless k3s runtime.
4. Connect each executor to the persistent setup transaction boundary.

npm publication remains paused.
