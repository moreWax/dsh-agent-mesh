# @morewax/dsh-agent-mesh

SAM-native capability mesh for DeepSeek Harness. One package, modular subpaths:

- `./core` — Unix-socket-first / TCP SAM connector, typed errors and feature probes
- `./tools` — policy-aware remote MCP discovery, describe and call
- `./inference` — OpenAI-compatible mesh inference, routing and label constraints
- `./tasks` — durable remote task vocabulary and orchestration helpers
- `./operator` — node diagnostics and human-approved lifecycle plans

## Two planes: what the mesh carries, and what it does not

This package works on the **agent plane**: capabilities — MCP tools, inference
models, durable tasks — travel between enrolled mesh nodes. That plane needs
no SSH, no exposed service ports, and no VPN: `sam-node` supplies direct
QUIC/TCP, NAT traversal, hole punching, DHT discovery and authenticated
circuit relays, with Biscuit-authorized calls.

The **human plane** is different by design. Web UIs — including the dsh Web
UI and this plugin's own operator card — are served to *browsers*, and a
browser is not a mesh node: it cannot enroll, hold mesh identity, or speak
mesh protocols. The mesh therefore does not, and will not, carry the Web UI.
To reach a dsh Web UI from another machine, use an ops-layer answer:
`tailscale serve`, an authenticated reverse proxy, or an SSH tunnel.

## Using the mesh from another machine (the client story)

There is no separate client application to install from us — the client is
`sam-node` plus whatever you already use:

1. **Install and enroll `sam-node`** on the laptop/peer (device-flow
   enrollment; `dsh-agent-mesh init --join` plans it, or `sam-node enroll`
   directly). Enrollment is what grants the machine mesh identity — firewalls
   and NAT do not matter after that.
2. **Consume the mesh** with any of:
   - **dsh + this plugin** on the laptop — the full integrated experience:
     remote tools appear as dsh tools, mesh models join the LLM roster, the
     operator card works exactly as on the server.
   - **This package's standalone CLI** — no dsh required; talks to the local
     node socket directly:

     ```bash
     npx @morewax/dsh-agent-mesh status     # mesh + node snapshot
     npx @morewax/dsh-agent-mesh tools      # remote tool roster (note peer ids)
     npx @morewax/dsh-agent-mesh models     # mesh inference models
     npx @morewax/dsh-agent-mesh call <peer> <tool> '{"arg": "value"}'
     ```

   - **Any MCP host** (Claude Code, Cursor, …) pointed at the local node's
     MCP endpoint — the mesh meta-tools (`find_remote_tools`,
     `call_remote_tool`, …) are plain MCP tools.

Everything reachable that way — including the task service your server-side
dsh publishes — travels the capability plane: no inbound ports opened on
either machine.

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

## Live acceptance

With `SAM_LIVE=1`, the suite validates the running node end-to-end: native
`ctx.tools` projection and remote echo execution, model inventory, streaming
inference, pinned proxy routing, and fail-closed impossible-label denial.

## Durable task service

`./tasks` includes `TaskService`, a pluggable atomic `TaskStore`, and an
`InMemoryTaskStore` reference implementation. It exposes the SAM-over-MCP
`task_submit/get/watch/cancel/collect` vocabulary with idempotency, CAS claims,
deadlines, cancellation, event cursors, artifacts and structured errors.

## Guided initialization

```bash
npx @morewax/dsh-agent-mesh init --profile web
```

The initializer first performs a read-only, idempotent checkup (binary, socket,
enrollment, connectivity, model endpoint, and harmless health probe). Use
`--start` and/or `--join` to plan those actions; each requires an interactive
approval unless `--yes` is supplied. Device enrollment runs in a detached waiter
with a private log under `$DSH_HOME/state/agent-mesh`, so it survives the `npx`
process. The SAM skill is installed into `$DSH_HOME/skills`, and the selected
profile patch is appended atomically without credentials. The command never
invokes `sam-node reset` or replaces existing user configuration.

## Controlled deployment acceptance

See [`acceptance/README.md`](acceptance/README.md) for self-skipping local/two-node checks and reference sam-box Kubernetes/VM profiles.

### Deployable Streamable HTTP endpoint

`TaskHttpServer` serves the five task tools at `/mcp` using MCP Streamable HTTP
(JSON responses, stateless sessions) and readiness at `/healthz`. Use
`SamTaskRegistrationClient` to register/unregister it with the local SAM node,
or mount the `@morewax/dsh-agent-mesh/tasks/service` Cordis plugin. The plugin
owns startup, SAM registration, cancellation, bounded shutdown, and unregister.

Run the real two-process acceptance check with `pnpm smoke:tasks`.

## DeepSeek Harness web UI

The host plugin exposes a strict Typert `agentMeshWeb` Remote and the browser plugin mounts an **Agent Mesh** card in `settings.section`. It reports the selected Unix/TCP transport, PeerID/router/peer/DHT and token/connectivity facts, local services, remote tools, models, durable tasks, logs, and per-probe failures. Check and enrollment instructions are safe/read-only. Start, skill install, and service registration are only invoked by explicit labeled user actions; missing approval fails closed. Reset/purge/delete/cancel actions are deliberately absent. Device enrollment stays in `sam-node enroll`; the UI never accepts a device code or credential.
