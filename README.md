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

## Development

```bash
pnpm install
pnpm -r build        # sam-mesh first (topological), then the plugin
pnpm -r test         # 70 tests across both packages
pnpm -r typecheck
```

## License

MIT — moreWax
