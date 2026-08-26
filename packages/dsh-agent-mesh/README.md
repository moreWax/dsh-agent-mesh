# @morewax/dsh-agent-mesh

SAM-native capability mesh plugin for DeepSeek Harness. Part of the
[dsh-agent-mesh workspace](https://github.com/moreWax/dsh-agent-mesh); the
standalone client + node kit is [`@morewax/sam-mesh`](../sam-mesh).

- Core client/node types come from [`@morewax/sam-mesh`](../sam-mesh) (a direct dependency)
- `./tools` — policy-aware remote MCP discovery, describe and call
- `./inference` — OpenAI-compatible mesh inference, routing and label constraints
- `./tasks` — durable remote task vocabulary, service, and orchestration
- `./operator` — node diagnostics and human-approved lifecycle plans

## Install

```bash
dsh plugin --profile web add @morewax/dsh-agent-mesh
dsh-agent-mesh init            # y/n checkup: profile patch, node checks, skill install
```

Requires an enrolled, running `sam-node` — bring one up from the Web UI
(Settings → Agent Mesh → Mesh node) or with `npx @morewax/sam-mesh node join`.

## Enrollment modes

- **Device flow (default)** — zero-config: the card shows a URL + code, a human
  authorizes in the browser. Right for the public hub and first-time setups.
- **Bootstrap token** — set `nodeEnrollmentCredentialRef` to a credential-store
  reference holding a hub-minted token (`sam:role:node`). Enrollment completes
  unattended and the node starts immediately after. Right for private hubs,
  where token minting (control-plane admin API) is the human gate.

The local-channel credential (`nodeCredentialRef`) self-provisions: a
configured-but-empty reference is generated and stored once, then written to
the node's `api-token` at every start — the node enforces it and every client
call presents it. One store, both ends of the channel.

## Configuration

Every plugin knob is editable in **Settings → Plugins → agent-mesh** — no YAML
required. Writes persist to `$DSH_HOME/settings.yaml` and layer over the Cordis
row config (which stays as the composition base):

| Key | Applies | Meaning |
| --- | --- | --- |
| `autoStartNode` | restart | Start the enrolled sam-node when dsh boots |
| `autoBeginEnrollment` | restart | On unenrolled machines, prepare the browser enrollment prompt at boot |
| `stopNodeOnExit` | live | When dsh started the node, stop it on dsh shutdown |
| `nodeControlPlane` | live | Mesh to join at enrollment (default `https://hub.sam-mesh.dev`) |
| `nodeEnrollmentCredentialRef` | live | Managed-store reference for a pre-shared enrollment token. Set = unattended bootstrap enrollment (no browser); empty = interactive device flow |
| `tcpUrl` / `socketPath` / `preferSocket` / `timeoutMs` | restart | Local node connection |

## Web UI

The settings card shows the live mesh dashboard (services, tools, models,
tasks, logs), approval-gated lifecycle actions, a **mesh doctor** (every
failure ships its fix command), and the complete zero-terminal onboarding
loop:

- **Mesh node** — binary picker (suggested: the bundled binary the package
  carries), daemon start/stop, browser-based device-flow enrollment with
  the verification URL + code rendered in the card
- **Join a fleet** — discover fleets on the swarm, request to join, watch
  the sealed invite land and provision itself (capability into the managed
  store — agent calls work immediately, profile patch for restart posture)
- **Fleet pairing** — the operator's approval queue: pending requests with
  label/id/age, approve/reject in one click

No terminal required on either side of onboarding.

## Security

Discovery labels are routing hints. Calls that request labels rely on SAM's
control-plane-signed Biscuit preflight before request bytes leave the node.
Label matching is any-of; this package names it `requiredLabelsAnyOf`.

The task service can run **capability-gated** (`capabilityCredentialRef`):
discovery stays open, but `tools/call` requires the fleet capability
(injected per call as `_capability`, compared in constant time, stripped
before tool schemas run; missing and wrong get the same refusal). A
configured-but-unresolvable ref fails CLOSED behind an ephemeral per-boot
secret. Fleet membership is delivered by **pairing**: the invite is sealed
to the joiner's ephemeral X25519 key (AES-256-GCM), and approval is always
an explicit human action — in the card or the CLI.

Mutations in the Web UI are approval-gated; destructive identity operations
(reset) are deliberately not exposed.

## License

MIT — moreWax
