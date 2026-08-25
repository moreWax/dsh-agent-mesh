# @morewax/dsh-agent-mesh

SAM-native capability mesh for DeepSeek Harness. One package, modular subpaths:

- `./core` — Unix-socket-first / TCP SAM connector, typed errors and feature probes
- `./tools` — policy-aware remote MCP discovery, describe and call
- `./inference` — OpenAI-compatible mesh inference, routing and label constraints
- `./tasks` — durable remote task vocabulary and orchestration helpers
- `./operator` — node diagnostics and human-approved lifecycle plans

## Connectivity

No SSH, mosh, or Tailscale is required. `sam-node` supplies direct QUIC/TCP,
NAT traversal, hole punching, DHT discovery and authenticated circuit relays.
The local integration prefers `~/.config/sam-mesh/sam.sock` (filesystem-authenticated,
no token), then falls back to loopback TCP with `X-Sam-Authentication`.
Destination `Authorization` is always a separate credential channel.

## Install

```bash
dsh plugin --profile web add @morewax/dsh-agent-mesh
```

Requires an enrolled, running `sam-node`. The operator module can diagnose and
plan setup, but destructive reset or interactive enrollment remains human-approved.

## Security

Discovery labels are routing hints. Calls that request labels rely on SAM's
control-plane-signed Biscuit preflight before request bytes leave the node.
Current SAM label matching is any-of; this package names it `requiredLabelsAnyOf`.
