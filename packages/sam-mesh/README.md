# @morewax/sam-mesh

SAM mesh client + node kit. Talks to a local `sam-node` — **no DeepSeek
Harness required** — and manages the node's lifecycle so any machine can
join the mesh. Zero runtime dependencies.

**`sam-node` is carried by the package.** The official google/sam release
binary for your platform ships inside `@morewax/sam-node-<os>-<arch>`
(optional dependency — you download only your platform, ~13MB gzipped),
checksum-verified at pack time and integrity-checked again at first use.
No installer script, no install-time network, no second tool. `SAM_NODE`
env or a PATH install still overrides.

## CLI

```bash
npx @morewax/sam-mesh node status                # installed / enrolled / running / pid
npx @morewax/sam-mesh node join [--control-plane <url>]
                                                 # OIDC device-flow enrollment; prints URL + code
npx @morewax/sam-mesh node join --bootstrap-token-path <file>
                                                 # pre-shared-token enrollment (no browser step);
                                                 # the hub operator mints the token out of band
npx @morewax/sam-mesh node start | node stop     # daemon lifecycle (idempotent)

npx @morewax/sam-mesh doctor                     # am I on the mesh? every failure prints its fix
npx @morewax/sam-mesh status                     # mesh + node snapshot
npx @morewax/sam-mesh peers                      # connected peers: short ids + services offered
npx @morewax/sam-mesh services [--filter <json>] # discover remote services
npx @morewax/sam-mesh tools [--filter <json>]    # remote tool roster (note peer ids)
npx @morewax/sam-mesh models                     # mesh inference models
npx @morewax/sam-mesh call <peer> <tool> '{"arg": "value"}'
                                                 # peer id OR unique prefix; bare tool names
                                                 # auto-qualify to mcp://<service>/<tool>
npx @morewax/sam-mesh tail <peer> <task-id>      # stream a remote task's events until it settles
npx @morewax/sam-mesh token mint --control-plane <url> --admin-token-path <file> [--ssh user@host] [--qr]
                                                 # mint a single-use enrollment token; optional
                                                 # ssh handoff one-liner / terminal QR (qrencode)
npx @morewax/sam-mesh fleet invite [--ssh u@h]    # create a one-file fleet invite (0600)
npx @morewax/sam-mesh fleet join --invite <file>   # seamless onboarding: hub-mismatch detection,
                                                 # enroll, capability, dsh patch, doctor
npx @morewax/sam-mesh skill                      # print the agent-facing onboarding doc
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
