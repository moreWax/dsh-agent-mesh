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
