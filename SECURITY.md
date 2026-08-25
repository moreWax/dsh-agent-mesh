# Security Policy

## Reporting a vulnerability

These packages handle credentials (API keys, tokens, SSH access) by design.
If you find a security issue — especially anything that could leak a secret
into config files, logs, model context, or a network peer — please report it
privately via GitHub's private vulnerability reporting on this repository
(Security → Advisories → Report a vulnerability).

Do not open a public issue for security reports.

## Scope notes

- Config files must never contain secret values (env/managed-store references
  only) — a regression here is a security bug.
- The sam driver must never send credentials to a non-SAM endpoint (enforced
  by preflight) — a bypass is a security bug.
- MCP content is untrusted input at a network boundary.

## Supported versions

Only the latest 0.x release receives fixes while the packages are pre-1.0.
