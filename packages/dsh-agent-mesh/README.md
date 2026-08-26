# @morewax/dsh-agent-mesh

SAM-native capability mesh plugin for DeepSeek Harness. Part of the
[dsh-agent-mesh workspace](https://github.com/moreWax/dsh-agent-mesh); the
standalone client + node kit is [`@morewax/sam-mesh`](../sam-mesh).

- `./core`-equivalents come from `@morewax/sam-mesh` (re-exported for compatibility)
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
tasks, logs), offers approval-gated lifecycle actions, and includes the
**Mesh node** section: install detection, daemon start/stop, and browser-based
device-flow enrollment — the verification URL and code render in the card;
you authorize in the browser and the machine joins the mesh. No terminal
required on the machine being enrolled.

## Security

Discovery labels are routing hints. Calls that request labels rely on SAM's
control-plane-signed Biscuit preflight before request bytes leave the node.
Label matching is any-of; this package names it `requiredLabelsAnyOf`.
Mutations in the Web UI are approval-gated; destructive identity operations
(reset) are deliberately not exposed.

## License

MIT — moreWax
