/** dsh-agent-mesh composition root: one socket-first SAM capability service. */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import { SamClient } from "./core/index.js"
import { SamToolClient } from "./tools/index.js"
import { SamInferenceClient } from "./inference/index.js"
import { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
import type { AgentMeshConfigInput, AgentMeshStatusService, MeshCheckup, SetupOptions, SetupPlan } from "./operator/index.js"

export const name = "agent-mesh"
export const provide = ["agentMesh", "agentMeshStatus"]
export type Config = AgentMeshConfigInput
export const Config: z<Config> = z.object({
  socketPath: z.union([z.string(), z.const(false)]).default("~/.config/sam-mesh/sam.sock"),
  tcpUrl: z.string().default("http://127.0.0.1:8080"),
  preferSocket: z.boolean().default(true),
  apiToken: z.string(),
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
  const core = new SamClient({ ...(config.socketPath !== undefined ? { socketPath: config.socketPath } : {}), tcpUrl: config.tcpUrl, preferSocket: config.preferSocket, timeoutMs: config.timeoutMs, ...(config.apiToken ? { apiToken: config.apiToken } : {}) })
  const operator = new SamOperator(core)
  ctx.provide("agentMesh", { core, tools: new SamToolClient(core), inference: new SamInferenceClient(core), operator })
  ctx.provide("agentMeshStatus", new CordisMeshStatus(operator))
}
export { SamClient, SamCoreClient } from "./core/index.js"
export { SamToolClient } from "./tools/index.js"
export { SamInferenceClient } from "./inference/index.js"
export { TaskClient } from "./tasks/index.js"
export { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
export type { AgentMeshStatusService } from "./operator/index.js"
