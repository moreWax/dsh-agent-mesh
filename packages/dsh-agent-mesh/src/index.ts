/** dsh-agent-mesh composition root: one socket-first SAM capability service. */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import type {} from "@deepseek-ai/dsh-credentials/types"
import { SamClient } from "@morewax/sam-mesh"
import { SamNodeManager } from "@morewax/sam-mesh/node"
import { SamToolClient } from "./tools/index.js"
import { SamInferenceClient } from "./inference/index.js"
import { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
import { AgentMeshWebHost } from "./web/host.js"
import type { AgentMeshConfigInput, AgentMeshStatusService, MeshCheckup, SetupOptions, SetupPlan } from "./operator/index.js"

export const name = "agent-mesh"
export const provide = ["agentMesh", "agentMeshStatus"]
export const inject = ["credentials"]
export type Config = AgentMeshConfigInput
export const Config: z<Config> = z.object({
  socketPath: z.union([z.string(), z.const(false)]).default("~/.config/sam-mesh/sam.sock"),
  tcpUrl: z.string().default("http://127.0.0.1:8080"),
  preferSocket: z.boolean().default(true),
  nodeCredentialRef: z.string(),
  timeoutMs: z.natural().default(30_000),
  /** Start an already-enrolled node daemon when the plugin boots (identity was human-granted at enrollment). Default true. */
  autoStartNode: z.boolean().default(true),
  /** On an unenrolled machine, begin device-flow enrollment at boot so the card shows the URL/code immediately. Completion always requires human browser authorization. Default true. */
  autoBeginEnrollment: z.boolean().default(true),
  /** Control plane for enrollment; defaults to the manager's (https://hub.sam-mesh.dev). */
  nodeControlPlane: z.string(),
}) as unknown as z<Config>

export interface AgentMeshService { core: SamClient; tools: SamToolClient; inference: SamInferenceClient; operator: SamOperator }
class CordisMeshStatus implements AgentMeshStatusService {
  constructor(private readonly operator: SamOperator) {}
  status(signal?: AbortSignal): Promise<MeshCheckup> { return this.operator.checkup(signal) }
  checkup(signal?: AbortSignal): Promise<MeshCheckup> { return this.operator.checkup(signal) }
  setup(options?: SetupOptions): SetupPlan { return this.operator.setup(options) }
}
declare module "@deepseek-ai/cordis" { interface Context { agentMesh: AgentMeshService; agentMeshStatus: AgentMeshStatusService } }

/** Derive the node data dir from the configured socket path (they live together by sam-node convention). */
function dataDirOf(socketPath: string | false | undefined): string | undefined {
  if (typeof socketPath !== "string") return undefined
  const home = process.env.HOME ?? ""
  const resolved = socketPath.startsWith("~/") ? `${home}/${socketPath.slice(2)}` : socketPath
  const slash = resolved.lastIndexOf("/")
  return slash > 0 ? resolved.slice(0, slash) : undefined
}

/**
 * Bring the node up with the plugin: an enrolled node is (re)started — its
 * identity was human-granted at enrollment, so starting just restores it.
 * An unenrolled machine gets an enrollment session so the settings card can
 * show the verification URL/code immediately; completion still requires the
 * human authorizing in the browser. Never throws the host down: every
 * failure degrades to a warning.
 */
async function autoNode(nodes: SamNodeManager, config: { autoStartNode?: boolean; autoBeginEnrollment?: boolean; nodeControlPlane?: string }, log: (line: string) => void): Promise<void> {
  const status = await nodes.status()
  if (!status.installed) { log(`sam-node not installed; mesh features stay degraded until it is (node kit: npx @morewax/sam-mesh node status)`) ; return }
  if (status.enrolled && !status.running && config.autoStartNode !== false) {
    const started = await nodes.start()
    if (started.ok) log(`sam-node auto-started: ${started.message}`)
    else log(`sam-node auto-start failed: ${started.error}`)
  }
  if (!status.enrolled && config.autoBeginEnrollment !== false) {
    const session = nodes.beginEnrollment(config.nodeControlPlane ? { controlPlane: config.nodeControlPlane } : {})
    log(`machine not enrolled: enrollment session ${session.sessionId} begun — authorize in the browser (Settings → Agent Mesh → Mesh node)`)
  }
}

export function apply(ctx: Context, input: Config): void {
  const config = parseAgentMeshConfig(input)
  const resolveNodeToken = config.nodeCredentialRef
    ? async () => (await ctx.credentials.resolve(credentialRef(config.nodeCredentialRef!)))?.value
    : undefined
  const core = new SamClient({ ...(config.socketPath !== undefined ? { socketPath: config.socketPath } : {}), tcpUrl: config.tcpUrl, preferSocket: config.preferSocket, timeoutMs: config.timeoutMs, ...(resolveNodeToken ? { resolveNodeToken } : {}) })
  const operator = new SamOperator(core)
  const service = { core, tools: new SamToolClient(core), inference: new SamInferenceClient(core), operator }
  ctx.provide("agentMesh", service)
  const dir = dataDirOf(config.socketPath)
  const nodes = new SamNodeManager(dir ? { dataDir: dir } : {})
  new AgentMeshWebHost(ctx, service, nodes)
  ctx.provide("agentMeshStatus", new CordisMeshStatus(operator))
  void autoNode(nodes, config, (line) => ctx.logger("agent-mesh").info(line))
}
export { SamClient, SamCoreClient } from "@morewax/sam-mesh"
export { SamToolClient } from "./tools/index.js"
export { SamInferenceClient } from "./inference/index.js"
export { TaskClient } from "./tasks/index.js"
export { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
export type { AgentMeshStatusService } from "./operator/index.js"

export { MeshObservability, defaultObservability } from "./observability/index.js"
export type { MetricsSnapshot, MetricPoint, AuditEvent, AuditSink } from "./observability/index.js"
