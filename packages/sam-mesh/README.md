# @morewax/sam-mesh

SAM mesh client + node kit. Talks to a local `sam-node` — **no DeepSeek
Harness required** — and manages the node's lifecycle so any machine can
join the mesh. Zero runtime dependencies.

## CLI

```bash
npx @morewax/sam-mesh node status                # installed / enrolled / running / pid
npx @morewax/sam-mesh node join [--control-plane <url>]
                                                 # OIDC device-flow enrollment; prints URL + code
npx @morewax/sam-mesh node start | node stop     # daemon lifecycle (idempotent)

npx @morewax/sam-mesh status                     # mesh + node snapshot
npx @morewax/sam-mesh services [--filter <json>] # discover remote services
npx @morewax/sam-mesh tools [--filter <json>]    # remote tool roster (note peer ids)
npx @morewax/sam-mesh models                     # mesh inference models
npx @morewax/sam-mesh call <peer> <tool> '{"arg": "value"}'
```

Env: `SAM_NODE` (binary override), `SAM_DATA_DIR` (default
`~/.config/sam-mesh`), `SAM_CONTROL_PLANE` (default `https://hub.sam-mesh.dev`),
`SAM_SOCKET`, `SAM_TCP_URL`.

## Library

```ts
import { SamClient } from '@morewax/sam-mesh'             // mesh client (socket-first, TCP fallback)
import { SamNodeManager } from '@morewax/sam-mesh/node'   // lifecycle: status/start/stop/enroll

const nodes = new SamNodeManager()
const status = await nodes.status()
if (!status.enrolled) {
  const session = nodes.beginEnrollment({})
  // session.verificationUrl / session.userCode appear as sam-node prints them;
  // session.done resolves when the user authorizes, or the session fails/cancels.
}
```

`EnrollmentSession` states: `starting → awaiting_user → complete | failed |
cancelled`. Identity reset (`sam-node reset`) is deliberately not exposed —
destructive identity operations stay human-terminal-only.

## License

MIT — moreWax
