import { planSamNodeCommand } from "./commands.js"
import { parseServiceRegistrationRequest, parseSkillInstallRequest } from "./schemas.js"
import type { Connectivity, Diagnostics, LogEntry, LogQuery, MeshService, NodeStatus, OperatorCore, Readiness, ServiceRegistrationRequest, SkillInstallPlan, SkillInstallRequest, TokenStatus } from "./types.js"

/** High-level node operations. The core owns all transport; this class never spawns a process. */
export class MeshOperator {
  constructor(private readonly core: OperatorCore) {}
  status(signal?: AbortSignal): Promise<NodeStatus> { return this.core.callTool<NodeStatus>("node.status", {}, signal) }
  readiness(signal?: AbortSignal): Promise<Readiness> { return this.core.callTool<Readiness>("node.readiness", {}, signal) }
  diagnostics(signal?: AbortSignal): Promise<Diagnostics> { return this.core.callTool<Diagnostics>("node.diagnostics", {}, signal) }
  services(signal?: AbortSignal): Promise<readonly MeshService[]> { return this.core.callTool<readonly MeshService[]>("service.list", {}, signal) }
  registerService(input: ServiceRegistrationRequest | unknown, signal?: AbortSignal): Promise<MeshService> {
    return this.core.callTool<MeshService>("service.register", { ...parseServiceRegistrationRequest(input) }, signal)
  }
  recentLogs(query: LogQuery = {}, signal?: AbortSignal): Promise<readonly LogEntry[]> {
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000)) throw new RangeError("log limit must be an integer from 1 to 10000")
    return this.core.callTool<readonly LogEntry[]>("node.logs", { ...query }, signal)
  }
  tokenStatus(signal?: AbortSignal): Promise<TokenStatus> { return this.core.callTool<TokenStatus>("node.token", {}, signal) }
  connectivity(signal?: AbortSignal): Promise<Connectivity> { return this.core.callTool<Connectivity>("node.connectivity", {}, signal) }
  planSkillInstall(input: SkillInstallRequest | unknown): SkillInstallPlan {
    const request = parseSkillInstallRequest(input)
    const args = ["skill", "install", request.source]
    if (request.name) args.push("--name", request.name)
    if (request.version) args.push("--version", request.version)
    if (request.target) args.push("--target", request.target)
    if (request.force) args.push("--force")
    return Object.freeze({ request: Object.freeze(request), command: planSamNodeCommand(args, "mutating") })
  }
}

export { MeshOperator as SamOperator }
