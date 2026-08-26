/** dsh-agent-mesh composition root: one socket-first SAM capability service. */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import type {} from "@deepseek-ai/dsh-credentials/types"
import { SamClient } from "@morewax/sam-mesh"
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
}) as unknown as z<Config>

export interface AgentMeshService { core: SamClient; tools: SamToolClient; inference: SamInferenceClient; operator: SamOperator }
class CordisMeshStatus implements AgentMeshStatusService {
  constructor(private readonly operator: SamOperator) {}
  status(signal?: AbortSignal): Promise<MeshCheckup> { return this.operator.checkup(signal) }
  checkup(signal?: AbortSignal): Promise<MeshCheckup> { return this.operator.checkup(signal) }
  setup(options?: SetupOptions): SetupPlan { return this.operator.setup(options) }
}
declare module "@deepseek-ai/cordis" { interface Context { agentMesh: AgentMeshService; agentMeshStatus: AgentMeshStatusService } }

export function apply(ctx: Context, input: Config): void {
  const config = parseAgentMeshConfig(input)
  const resolveNodeToken = config.nodeCredentialRef
    ? async () => (await ctx.credentials.resolve(credentialRef(config.nodeCredentialRef!)))?.value
    : undefined
  const core = new SamClient({ ...(config.socketPath !== undefined ? { socketPath: config.socketPath } : {}), tcpUrl: config.tcpUrl, preferSocket: config.preferSocket, timeoutMs: config.timeoutMs, ...(resolveNodeToken ? { resolveNodeToken } : {}) })
  const operator = new SamOperator(core)
  const service = { core, tools: new SamToolClient(core), inference: new SamInferenceClient(core), operator }
  ctx.provide("agentMesh", service)
  new AgentMeshWebHost(ctx, service)
  ctx.provide("agentMeshStatus", new CordisMeshStatus(operator))
}
export { SamClient, SamCoreClient } from "@morewax/sam-mesh"
export { SamToolClient } from "./tools/index.js"
export { SamInferenceClient } from "./inference/index.js"
export { TaskClient } from "./tasks/index.js"
export { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
export type { AgentMeshStatusService } from "./operator/index.js"

export { MeshObservability, defaultObservability } from "./observability/index.js"
export type { MetricsSnapshot, MetricPoint, AuditEvent, AuditSink } from "./observability/index.js"
