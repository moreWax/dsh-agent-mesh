# Release notes — v0.1.0 (first public publish)

## Packages

| package | version | notes |
|---|---|---|
| `@morewax/sam-mesh` | 0.1.0 | client + node kit + CLI (`sam-mesh`); zero runtime deps |
| `@morewax/dsh-agent-mesh` | 0.1.0 | the dsh plugin: mesh node lifecycle, fleet pairing/members, capability-gated tasks + inference, live steering, operator surfaces |
| `@morewax/dsh-mesh-chat` | 0.1.0 | authenticated mesh chat: fleet channel + DMs + sealed notifications |
| `@morewax/sam-node-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}` | 0.2.0-ci.6502323 | sam-node CI-built from pinned google/sam commit (device-flow fix untagged upstream) |
| `@morewax/llama-cpp-{…}` | 0.10642.0 | llama.cpp b10642 binaries (version tracks upstream tag) |

## Version scheme

- Our packages: independent 0.x semver; breaking changes bump minor until 1.0.
- Vendored-binary packages: the version IS the provenance (llama tag, sam commit).
- optionalDependencies pin via workspace:* → exact versions at publish.

## Headline capabilities

- **One-command install**: `dsh plugin add @morewax/dsh-agent-mesh` — sam-node AND llama.cpp binaries vendored per-platform, zero install-time network
- **Card-driven everything**: enroll (device flow with live countdown and automatic transient-retry), join fleets, approve pairings, administer members, serve models, steer them live — no terminal, no SSH, no copied secrets
- **Per-member capabilities**: minted at pairing or via one-time invite codes; scoped (`tasks`/`inference`); revocation is registry deletion, effective next call, everywhere
- **Listing is the phone book, execution is gated** — for tasks AND inference
- **Mesh chat**: capability-gated fleet channel with system events, rate-limited DM inboxes, sealed per-member notification fan-out
- **Live model steering**: system prompt + sampling defaults at the gate, next request, operator-gated
- **Self-healing identities**: startup AND runtime trust-staleness detection with silent re-enrollment; honest browser escalation when the refresh token dies (banner + doctor)
- **Operator surfaces**: invite codes, member admin, bounded remote diagnostics (`peer_exec`), all reachable from any operator machine through the mesh

## Known limitations (honest)

- Vendored llama.cpp builds are CPU/Metal (vulkan/CUDA are follow-ups)
- `peer_exec` runs as the member machine's dsh user — it is a deliberate operator capability, audited as system events, and can be disabled (`peerExec: false`)
- sam-node is a CI build, not an official release (device-flow fix untagged; google/sam#320)
- Public-hub key rotation currently lacks a client catch-up path (google/sam#325) — our watcher heals via re-enrollment; a cheaper path lands when upstream provides key material outside enrollment
- DMs carry self-claimed sender names until the node stamps verified peer identity on service proxies (google/sam#323)
