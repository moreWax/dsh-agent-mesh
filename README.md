# dsh-agent-mesh

SAM-native capability mesh for DeepSeek Harness — a pnpm workspace with two packages:

| Package | Role | Runs on |
| --- | --- | --- |
| [`@morewax/sam-mesh`](packages/sam-mesh) | **Client + node kit.** Talks to a local `sam-node` (no dsh required) and manages its lifecycle — install check, daemon start/stop, OIDC device-flow enrollment with automatic transient-retry, and a **runtime trust watcher** that self-heals hub key rotations. Zero runtime dependencies. | Any enrolled machine — laptop, jump host, server |
| [`@morewax/dsh-agent-mesh`](packages/dsh-agent-mesh) | **dsh plugin.** Consumes mesh tools/models/tasks into the harness, publishes dsh's durable task service onto the mesh, and exposes node management, fleet administration, model serving + **live steering**, and an operator **diagnostics console** in the Web UI. | Inside a dsh host |
| [`@morewax/dsh-mesh-chat`](packages/dsh-mesh-chat) | **dsh plugin.** Authenticated chat over the mesh: a capability-gated **fleet channel** (with fleet system events) and **direct messages** between nodes, plus sealed per-member notifications over the mesh's pubsub. | Inside a dsh host |

`packages/dsh-integration` is private (the cross-package wire-level test
harness; never published). `@morewax/sam-node-<os>-<arch>` and
`@morewax/llama-cpp-<os>-<arch>` carry the vendored binaries as optional
dependencies (you download only your platform).

The split follows the trust boundary: `sam-mesh` never imports dsh; the plugin
depends on it via the workspace. Both share sam-node's wire contract and
version in lockstep.

## Two planes: what the mesh carries, and what it does not

This workspace works on the **agent plane**: capabilities — MCP tools,
inference models, durable tasks — travel between enrolled mesh nodes. That
plane needs no SSH, no exposed service ports, and no VPN: `sam-node` supplies
direct QUIC/TCP, NAT traversal, hole punching, DHT discovery and authenticated
circuit relays, with Biscuit-authorized calls.

The **human plane** is different by design. Web UIs — including the dsh Web
UI and the plugin's operator card — are served to *browsers*, and a browser
is not a mesh node: it cannot enroll, hold mesh identity, or speak mesh
protocols. The mesh therefore does not, and will not, carry the Web UI. To
reach a dsh Web UI from another machine, use an ops-layer answer:
`tailscale serve`, an authenticated reverse proxy, or an SSH tunnel.

## Quick start

On any machine that should join the mesh:

```bash
npx @morewax/sam-mesh node status     # installed / enrolled / running?
npx @morewax/sam-mesh node join       # device-flow enrollment (prints URL + code)
npx @morewax/sam-mesh node start      # daemonize
npx @morewax/sam-mesh tools           # what the mesh offers
```

In a dsh host, the same lifecycle is available from the Web UI: install the
plugin (`dsh plugin --profile web add @morewax/dsh-agent-mesh`), open
Settings → Agent Mesh, and use the **Mesh node** section — enrollment shows
the verification URL and code right in the card.

## Onboarding — completely in the UI

Joining a fleet needs no terminal, no SSH, and no copied secrets — on either
side:

1. **New machine** — Settings → Agent Mesh: *Enroll this machine* (the
   device-flow URL + code render in the card; approve in the browser)
2. **Join a fleet → Discover fleets** — the swarm browser lists fleets by
   service name with their providers → *Request to join*
3. **Operator** — their own card's *Fleet pairing* section shows the request
   (label, request id, age) → *Approve*
4. The invite is **sealed to the joiner's ephemeral key** (X25519 →
   AES-256-GCM — only that machine can open it), delivered through the mesh,
   and provisioned in place: capability into dsh's managed credential store
   (agent calls to fleet services work **immediately**), profile patch for
   restart posture, CLI parity file. The card shows ✓ with provisioning
   notes.

The card also carries the **pairing approvals queue**, a **mesh doctor**
(5s poll, every failure ships its fix command), and a **sam-node binary
picker** (below). The CLI mirrors every step for terminals-only machines —
see [docs/join-the-fleet.md](docs/join-the-fleet.md).

## Security model

- **Always encrypted**: every mesh transport is end-to-end noise-encrypted;
  relays see ciphertext. Direct connections upgrade out of relays (DCUtR)
  automatically — peers are pure dial-out, no open ports, no VPN.
- **Discovery is public, execution is not.** Announcing a service on the
  public hub publishes a phone-book entry (service name + peer id). Calling
  a gated tool requires a fleet **capability** — injected per call, compared
  in constant time, stripped before tool schemas see the arguments. Missing
  and wrong credentials get the same refusal.
- **Per-member capabilities, not one shared key.** Pairing (or a one-time
  **invite code**) mints a unique capability per approved member with
  explicit scopes (`tasks`, `inference`; `admin` is never granted through
  pairing). The shared secret stays on the operator as the *operator
  credential*. **Revocation is registry deletion** — effective on the next
  gated call at the task service and every inference gate — and every gated
  call is attributed to a member in the audit stream (and, where the mesh
  transport exposes it, the calling peer).
- **Fleet administration from anywhere.** Pairing approvals, member lists,
  revocations, invite-code generation, model steering, and bounded
  diagnostics (`peer_exec`) are all operator tools on the fleet server —
  reachable from **any** machine holding the operator credential, through
  the mesh, never around it.
- **Fail closed**: a configured-but-unresolvable capability ref gates the
  service behind an ephemeral per-boot secret — every mesh call rejects —
  and logs loudly. In-process callers bypass the gate (same trust domain).
- **Pairing is the human gate**: pair request/poll are deliberately open
  (unguessable 128-bit ids, sealed payloads, single-use delivery) — the
  *approval* is what gates access, and approval is always an explicit human
  action (card button or CLI), consistent with skill installs and service
  registration.

## Mesh chat — a channel between your machines

`@morewax/dsh-mesh-chat` adds authenticated chat: a **fleet channel** where
members talk and *fleet events narrate themselves* (pairings, approvals,
revocations, gate denials as system messages), and **direct messages** —
every node runs a rate-limited inbox, and a DM is an authenticated mesh
call to a peer's inbox. Freshness rides the mesh's own pubsub: messages are
fanned out **sealed per member** (each member's key is derived from their
capability, so revocation kills delivery with zero push), while history
stays durable in SQLite on the fleet server. The card section is Settings →
Mesh chat.

## Live model steering

Serve rows accept live steering — a system prompt and sampling defaults
applied by the gate on the *next* request (`inference_steer`, operator
gated). Tune a served model mid-conversation from the Model steering window
in the Agent Mesh card, the ⚙ steer strip in the Mesh chat card, or the
composer dock on any conversation page.

## Operator surfaces

`fleet_invite_create` mints one-time codes (15 min, single-use — possession
is the approval; a wrong code degrades to the approval queue, never a
lockout). `peer_exec` runs bounded shell commands on member machines over
the mesh — gated by the *member's* capability, which only the member and
the operator hold — and the Fleet administration card exposes it as a
diagnostics console. A **runtime trust watcher** heals hub key rotations
silently (and `sam-mesh doctor` flags signature trust and refresh-token
health before they bite).

## The sam-node binary is included

`dsh plugin add` is the *only* download. A `sam-node` binary for your
platform ships inside `@morewax/sam-node-<os>-<arch>`
(an optional dependency — you download only your platform, ~13MB gzipped),
integrity-checked against its packed manifest at first execution. No
installer script, no install-time network.

**Provenance:** the binary is currently **CI-built from a pinned
`google/sam` commit** (`6502323`, `scripts/build-sam-binaries.mjs` —
reproduce it yourself or via the build-sam-node workflow and compare
sha256). We build instead of shipping the official release tarball because
every release ≤ `v0.1.0-alpha.7` cannot complete device-flow enrollment
against the hub's identity provider (the token poll dies on dex's
non-RFC 401 pending responses; upstream fix `994d082a` is in no release).
`scripts/fetch-sam-binaries.mjs` (official tarballs, checksums.txt
verified) is the documented switch-back once upstream tags the fix.

Resolution: `SAM_NODE` env → **bundled** (lazy-extracted to
`~/.config/sam-mesh/vendor/`, cached by content hash) → PATH. The settings
card's *sam-node binary* dropdown lists every usable binary on the machine
with the suggestion preselected (`Auto — bundled v…`); `sam-mesh node
binary` prints the same list in a terminal, ★ = suggested.

## Mesh inference — serve your GPU models, pick them in dsh on any fleet machine

Any fleet machine can serve an OpenAI-compatible backend (vLLM, LiteLLM,
Ollama, …) on the mesh behind the same capability gate as tasks. Model
**listing is open** (the phone book); **execution is gated** — every
completion requires the fleet capability (timing-safe, uniform 403, the
backend is never touched). The gate strips the capability header and any
inbound `Authorization`, and injects the upstream credential instead — it
never crosses the mesh.

**Consume side: zero steps.** The `agent-mesh-llm` row projects mesh models
into dsh's model picker under the **sam-mesh** provider and resolves the
fleet capability per call. With no config of its own it falls back to the
`agent-mesh` row's `callCapabilityRef` — which the pairing flow already
writes. Join the fleet, restart dsh, pick a mesh model. That's it.

**Serve side: the standard is OpenAI `/v1`.** Any backend that answers
`/v1/models` + `/v1/chat/completions` on a loopback port can be served —
Ollama, LM Studio, llama.cpp, vLLM, LiteLLM. Two ways to point the row at
one:

*Easiest — auto-detect.* With `target: auto` the row probes the well-known
backends (Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000,
LiteLLM :4000/:4001), picks deterministically, and logs what it found
(including every other candidate, so you can pin explicitly when you run
more than one). Someone whose whole "infrastructure" is Ollama on a laptop
serves their models to the fleet with this one block:

```yaml
- insert:
    - id: agent-mesh-inference
      name: '@morewax/dsh-agent-mesh/inference/serve'
      config:
        target: auto
        announceName: my-laptop-models
```

*Explicit — any endpoint.* Full control over target, port, upstream auth,
and the mesh-wide name:

```yaml
- insert:
    - id: agent-mesh-inference
      name: '@morewax/dsh-agent-mesh/inference/serve'
      config:
        target: http://127.0.0.1:4001        # your OpenAI-compatible backend (REQUIRED)
        port: 4100
        upstreamAuthCredentialRef: MESH_INFERENCE_UPSTREAM_AUTH   # store ref, injected upstream
        announceName: morewax-gpu-inference  # mesh-wide service name
```

Per-backend recipes for the explicit form — install the backend per its own
docs, then use its loopback URL as `target`:

| Backend | Serve command | `target` |
| --- | --- | --- |
| Ollama | `ollama serve` (runs by default) | `http://127.0.0.1:11434` |
| LM Studio | start the local server in the app | `http://127.0.0.1:1234` |
| llama.cpp | `llama-server -m model.gguf` | `http://127.0.0.1:8080` |
| vLLM | `vllm serve <model>` | `http://127.0.0.1:8000` |
| LiteLLM | `litellm --config config.yaml` | `http://127.0.0.1:4000` |

Auth-bearing backends (LiteLLM, gated vLLM): put the key in the dsh
credential store and set `upstreamAuthCredentialRef` — the gate injects it
upstream and it never crosses the mesh. No `capabilityCredentialRef` needed
in either form — the gate falls back to the fleet capability every member
already holds, re-resolved on an interval (rotation-safe; empty means every
execution 403s — fail closed). The row refuses non-loopback binds and
refuses to start ungated without `allowUngated: true`. It self-announces and
re-announces every 30s, so node restarts self-heal. dsh restarts take the
proxy down with them — run dsh under a service manager for a permanent serve
side.

**Nothing installed at all?** The package carries a vendored llama.cpp
runtime (official ggml-org release b10642, per-platform, integrity-checked —
same doctrine as the vendored sam-node). Pick **Built-in runtime** in the
card's Share-models section, enter a Hugging Face model
(`org/repo`, `org/repo:quant`, or `org/repo/file.gguf`), and select Download
— an explicit, approved download into the local store (boot code never
downloads). Then Start sharing: dsh boots the runtime with the model, gates
it, and announces it. On the CLI:

```bash
node packages/sam-mesh/lib/cli/index.mjs runtime status
node packages/sam-mesh/lib/cli/index.mjs runtime pull 'unsloth/SmolLM2-135M-Instruct-GGUF:Q8_0'
```

The serve-row form (what the card writes) is:

```yaml
- insert:
    - id: agent-mesh-inference
      name: '@morewax/dsh-agent-mesh/inference/serve'
      config:
        runtime:
          model: unsloth/SmolLM2-135M-Instruct-GGUF:Q8_0
          alias: smollm2-135m
          port: 8180
        announceName: my-models
```

No dsh on the serving machine? The standalone CLI does the same job:

```bash
export SAM_INFERENCE_UPSTREAM_AUTH=change-me-upstream-key
export SAM_INFERENCE_CAPABILITY=change-me-fleet-capability
node packages/sam-mesh/lib/cli/index.mjs inference-proxy \
  --target http://127.0.0.1:4001 --port 4100 --announce-name morewax-gpu-inference
```

## CLI## CLI

`sam-mesh` (or `npx @morewax/sam-mesh`) — action-routed, agent-friendly:

| Command | What it does |
| --- | --- |
| `node status` / `start` / `stop` | node lifecycle (`status` reports binary source, enrollment hub, pid) |
| `node join` | device-flow enrollment (URL + code); `--bootstrap-token-path` for pre-shared |
| `node binary` | every usable sam-node on the machine, ★ = suggested |
| `doctor` | live checks with a fix command per failure (hub detail included) |
| `peers` | connected peers, short ids, announced services |
| `services` / `tools` / `models` | mesh discovery |
| `call <peer> <tool>` | invoke a mesh tool; bare tool names auto-qualify via discovery, unique peer prefixes expand |
| `tail <peer> <task-id>` | stream a task to its terminal status |
| `token mint [--ttl] [--ssh u@h]` | bootstrap token; `--ssh` prints the one-line handoff, `--qr` a QR |
| `fleet discover` | find fleets on the hub by service name |
| `fleet invite [--generate] [--ssh]` | sealed invite file for air-gapped / private-hub onboarding |
| `fleet join --fleet <name>` | request-to-join via pairing (no files) |
| `fleet join --invite <file>` | file-based join |
| `fleet approvals [approve\|reject <id>]` | operator-side pairing queue |
| `skill` | print the agent onboarding doc (also at [docs/agent-skill.md](docs/agent-skill.md)) |

## Install from source (until npm publish lands)

```bash
git clone https://github.com/moreWax/dsh-agent-mesh 2>/dev/null || git -C dsh-agent-mesh pull
cd dsh-agent-mesh
corepack enable
pnpm setup
```

`pnpm setup` walks the whole flow interactively, asking before **every**
network action — nothing downloads silently:

1. **DeepSeek Harness** — the plugin runs inside dsh, so it is required. If
   no checkout is found (sibling directory, `~/deepseek-harness`, or
   `$DSH_CHECKOUT`), setup **asks** whether to download and build it for you.
2. **Workspace install** (`pnpm install`) and **build** (`pnpm -r build`).
3. **Vendored sam-node binaries** — offered, not forced (~13MB for your
   platform, official release, checksum-verified). Skip and the node manager
   falls back to a `sam-node` already on your PATH.
4. **Plugin registration** — offered last: links the plugin into your dsh
   `web` profile and prints the command to start the Web UI.

In a non-interactive shell (CI, scripts) setup prints the manual steps and
touches nothing. Then open **Settings → Agent Mesh** in the Web UI —
enroll, discover fleets, join, approve: all in the card, no further
downloads, no terminal.

## Development

```bash
pnpm install
pnpm fetch:binaries  # only needed for the bundled-binary paths (pack/publish)
pnpm -r build
pnpm -r test         # 150 tests across the workspace
pnpm -r typecheck
```

## License

MIT — moreWax
