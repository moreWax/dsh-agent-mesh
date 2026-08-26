# sam-mesh — agent skill

You are operating on a machine that can join (or already joined) a Sovereign
Agent Mesh. The mesh lets enrolled machines discover and call each other's
MCP tools over libp2p. Everything below is runnable; commands never mutate
remote state without an explicit command from you.

## Contract

- All output is JSON unless a command prints a human block explicitly.
- Peer ids may be given as full ids or unique prefixes.
- Tool names must be URI form (`mcp://<service>/<tool>`); `call` and
  `tail` auto-qualify bare names when the peer announces exactly one service.
- Enrollment tokens are single-use and are consumed even by failed joins —
  re-mint before retrying a failed join.

## Diagnose first

```bash
sam-mesh doctor
```
Each check is ✓ or ✗ with the exact fix command under every failure. Run
doctor before anything else and after every change.

## Onboard this machine

```bash
sam-mesh node install                                  # installs sam-node (offers, never silent)
sam-mesh node join --control-plane <hub-url>   --bootstrap-token-path ~/sam-join-token              # file, never inline
sam-mesh doctor                                        # verify
```

If you are the hub operator preparing another machine:

```bash
sam-mesh token mint --control-plane <hub-url>   --admin-token-path <admin-token-file>   [--role sam:role:node] [--ssh user@host] [--qr]
```
Prints the token as a 0600-file recipe, optionally an ssh one-liner for
placing it, and optionally a terminal QR (requires system `qrencode`).

## Use the mesh

```bash
sam-mesh peers                      # short ids + services per peer
sam-mesh services                   # what remote peers announce
sam-mesh call <peer> <tool> '<json-args>'
sam-mesh tail <peer> <task-id>      # stream task events until it settles
sam-mesh models                     # mesh inference endpoints (OpenAI-compatible)
```

## Invariants

- `sam-node reset` is destructive (identity loss) and stays human-only —
  do not run it as part of automation.
- Never pass tokens as inline argv; always via file paths.
- A machine can consume the mesh without announcing services; announcing
  nothing is not a failure.

