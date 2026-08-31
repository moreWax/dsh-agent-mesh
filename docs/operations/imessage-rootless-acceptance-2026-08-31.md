# Rootless runtime acceptance — escha — 2026-08-31

## Passed

- Fresh isolated runtime root under `/tmp`.
- Actual release download for k3s, RootlessKit, and slirp4netns x64.
- All pinned SHA-256 checks passed before installation.
- Executables installed in user-owned paths.
- User systemd is available; transient `Delegate=yes` scope works.
- Generated permanent user unit passed systemd loading after WorkingDirectory syntax correction.
- Unit uses only `systemctl --user`, `Delegate=yes`, no root service, and no privilege escalation.
- Interrupted-download cleanup/retry and lifecycle restart are covered by automated tests.
- Temporary service, unit, and runtime root were removed; service verified inactive.

## Environmental block discovered

Ubuntu AppArmor reports:

```text
kernel.apparmor_restrict_unprivileged_userns = 1
```

The pinned k3s process consequently fails rootless child creation with:

```text
failed to start the child: fork/exec /proc/self/exe: operation not permitted
```

The plugin now checks this condition before downloading or starting and reports an actionable choice: administrator-provided AppArmor permission, existing Kubernetes, or external Matrix. It does not modify the sysctl, write an AppArmor profile, invoke sudo, or fall back to root.

## Gates still requiring another host

- Successful pod networking, DNS, and local storage on a host whose security policy permits rootless user namespaces.
- Linux arm64 execution on real arm64 hardware.

The blocked checks must not be represented as passed and npm publication remains paused.
