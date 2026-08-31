# Experimental iMessage/Matrix cluster inventory — 2026-08-31

This inventory marks resources eligible for cleanup. It contains no Secret values.

## Cluster

- k3s `v1.36.4+k3s1`
- kubeconfig: `/etc/rancher/k3s/k3s.yaml`
- experimental namespaces: `matrix`, `imessage`

## `matrix` namespace

- Running: Postgres and Synapse deployments/services
- Scaled to zero: corten-matrix deployment
- Completed: `corten-setup`, `synapse-generate`
- PVCs: `postgres-data` (observed terminating), `synapse-data`, `corten-data`
- ConfigMap: `synapse-patch`
- Known experimental issues: PVC ownership, locale/config generation, corten release is a glibc binary rather than an OCI image, interactive activation cannot be an ordinary container entrypoint.

## `imessage` namespace

- CrashLoopBackOff: `synapse`, `corten-matrix`
- Services: `synapse`, `corten`
- PVCs: `synapse-data`, `corten-data` (pending)
- These resources contain placeholder/experimental configuration and are not a production deployment.

## Cleanup boundary

Only namespaces `matrix` and `imessage`, including their namespaced PVCs, are eligible for cleanup. `kube-system`, `default`, SAM, dsh, LiteLLM, and host services are out of scope. Cleanup must be followed by namespace absence and no remaining associated PV verification.

## Cleanup result

Cleanup completed after the inventory and local diagnostic export:

- Deleted namespaces: `matrix`, `imessage`
- Verified both namespaces are absent
- Verified no PV remains with a claim reference to either namespace
- Remaining namespaces: `default`, `kube-system`, `kube-public`, `kube-node-lease`
- Diagnostic export retained locally with mode `0600` under `~/.local/state/dsh-imessage/experimental-cluster-export-2026-08-31/`; it is not committed because resource specifications can contain sensitive environment data.
