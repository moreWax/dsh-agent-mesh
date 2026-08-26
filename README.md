# dsh-agent-mesh

SAM-native capability mesh for DeepSeek Harness — a pnpm workspace with two packages:

| Package | Role | Runs on |
| --- | --- | --- |
| [`@morewax/sam-mesh`](packages/sam-mesh) | **Client + node kit.** Talks to a local `sam-node` (no dsh required) and manages its lifecycle — install check, daemon start/stop, OIDC device-flow enrollment. Zero runtime dependencies. | Any enrolled machine — laptop, jump host, server |
| [`@morewax/dsh-agent-mesh`](packages/dsh-agent-mesh) | **dsh plugin.** Consumes mesh tools/models/tasks into the harness, publishes dsh's durable task service onto the mesh, and exposes node management (including browser-based enrollment) in the Web UI settings. | Inside a dsh host |

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
  a gated tool requires the fleet **capability** — a shared secret held only
  by fleet members, injected per call, compared in constant time, stripped
  before tool schemas see the arguments. Missing and wrong credentials get
  the same refusal.
- **Fail closed**: a configured-but-unresolvable capability ref gates the
  service behind an ephemeral per-boot secret — every mesh call rejects —
  and logs loudly. In-process callers bypass the gate (same trust domain).
- **Pairing is the human gate**: pair request/poll are deliberately open
  (unguessable 128-bit ids, sealed payloads, single-use delivery) — the
  *approval* is what gates access, and approval is always an explicit human
  action (card button or CLI), consistent with skill installs and service
  registration.

## The sam-node binary is included

`dsh plugin add` is the *only* download. The official `google/sam` release
binary for your platform ships inside `@morewax/sam-node-<os>-<arch>`
(an optional dependency — you download only your platform, ~13MB gzipped),
checksum-verified against the release's published SHA-256 sums at pack time
and integrity-checked again at first execution. No installer script, no
install-time network.

Resolution: `SAM_NODE` env → **bundled** (lazy-extracted to
`~/.config/sam-mesh/vendor/`, cached by content hash) → PATH. The settings
card's *sam-node binary* dropdown lists every usable binary on the machine
with the suggestion preselected (`Auto — bundled v…`); `sam-mesh node
binary` prints the same list in a terminal, ★ = suggested.

## CLI

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

**Prerequisite — dsh itself** (the plugin runs inside the harness, which is
also source-installed today). Skip this block if you already have it:

```bash
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness
corepack enable
pnpm install
pnpm -r build
cd ..
```

**Then this workspace.** The first line clones, or pulls if you already have
a checkout — safe to paste on any machine, fresh or returning:

```bash
git clone https://github.com/moreWax/dsh-agent-mesh 2>/dev/null || git -C dsh-agent-mesh pull
cd dsh-agent-mesh
pnpm install
pnpm fetch:binaries
pnpm -r build
node ../deepseek-harness/apps/cli/src/bin.ts plugin --profile web add link:$(pwd)/packages/dsh-agent-mesh
```

What each step does:

- `pnpm fetch:binaries` vendors the official sam-node release binaries
  (checksum-verified, ~13MB for your platform). **Optional** — skip it and
  the node manager falls back to a `sam-node` already on your PATH;
  `sam-mesh node binary` shows every candidate and the suggestion either way.
- `pnpm -r build` compiles sam-mesh first (topological), then the plugin.
- The last line registers the plugin with your dsh `web` profile. Adjust the
  path if your deepseek-harness checkout lives elsewhere.

Everything after the install — enroll, discover fleets, join, approve —
happens in **Settings → Agent Mesh**; no further downloads, no terminal.

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
