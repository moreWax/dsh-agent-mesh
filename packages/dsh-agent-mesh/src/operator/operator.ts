import { planSamNodeCommand } from "./commands.js"
import { parseServiceRegistrationRequest, parseSkillInstallRequest } from "./schemas.js"
import type { Connectivity, Diagnostics, LogEntry, LogQuery, MeshCheckup, MeshService, NodeStatus, OperatorCore, Readiness, ServiceRegistrationRequest, ServiceRegistrationResponse, SetupOptions, SetupPlan, SkillInstallPlan, SkillInstallRequest, TokenStatus } from "./types.js"

/** High-level node operations. The core owns all transport; this class never spawns a process. */
export class MeshOperator {
  constructor(private readonly core: OperatorCore) {}
  status(signal?: AbortSignal): Promise<NodeStatus> { return this.core.callTool<NodeStatus>("get_mesh_info", {}, signal) }
  readiness(signal?: AbortSignal): Promise<Readiness> { return this.core.callTool<Readiness>("get_network_info", {}, signal) }
  diagnostics(signal?: AbortSignal): Promise<Diagnostics> { return this.core.callTool<Diagnostics>("get_network_info", {}, signal) }
  services(signal?: AbortSignal): Promise<readonly MeshService[]> { return this.core.callTool<readonly MeshService[]>("list_local_services", {}, signal) }
  registerService(input: ServiceRegistrationRequest | unknown, signal?: AbortSignal): Promise<MeshService> {
    const request = parseServiceRegistrationRequest(input)
    return this.core.request<ServiceRegistrationResponse | MeshService>("/sam/service/register", { method: "POST", body: { service: { name: request.name, type: request.protocol, ...(typeof request.metadata?.description === "string" ? { description: request.metadata.description } : {}) }, target_url: request.endpoint, ...(request.ttlSeconds !== undefined ? { ttl_seconds: request.ttlSeconds } : {}) }, ...(signal ? { signal } : {}) }).then((result) => "service" in result && result.service ? result.service : result as MeshService)
  }
  async recentLogs(query: LogQuery = {}, signal?: AbortSignal): Promise<readonly LogEntry[]> {
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000)) throw new RangeError("log limit must be an integer from 1 to 10000")
    // The release alpha.7 get_recent_logs schema rejects unknown arguments
    // (limit is a HEAD-era addition) — call arg-free and slice client-side so
    // the probe works on every binary the package can carry.
    const { limit, ...rest } = query
    const logs = await this.core.callTool<readonly LogEntry[]>("get_recent_logs", rest, signal)
    return limit === undefined ? logs : logs.slice(-limit)
  }
  tokenStatus(signal?: AbortSignal): Promise<TokenStatus> { return this.core.callTool<TokenStatus>("get_token_info", {}, signal) }
  connectivity(signal?: AbortSignal): Promise<Connectivity> { return this.core.callTool<Connectivity>("get_network_info", {}, signal) }

  /** Run independent, read-only probes. A failed probe is reported instead of masking the others. */
  async checkup(signal?: AbortSignal): Promise<MeshCheckup> {
    const probes = ["get_mesh_info", "get_network_info", "get_token_info", "list_local_services"] as const
    const values = await Promise.allSettled(probes.map((name) => this.core.callTool<unknown>(name, {}, signal)))
    const failures = values.flatMap((value, index) => value.status === "rejected" ? [{ name: probes[index]!, ok: false, message: value.reason instanceof Error ? value.reason.message : String(value.reason) }] : [])
    const output: MeshCheckup = { healthy: failures.length === 0, mesh: values[0]?.status === "fulfilled" ? values[0].value : undefined, failures, capturedAt: new Date().toISOString() }
    if (values[1]?.status === "fulfilled") output.network = values[1].value
    if (values[2]?.status === "fulfilled") output.token = values[2].value
    if (values[3]?.status === "fulfilled") output.services = values[3].value as readonly MeshService[]
    return output
  }
  /** Return setup argv plans only. Nothing is spawned, written, or started by this API. */
  setup(options: SetupOptions = {}): SetupPlan {
    const commands = []
    if (options.createConfig) commands.push(planSamNodeCommand(["init"], "mutating"))
    if (options.startNode) commands.push(planSamNodeCommand(["run"], "mutating"))
    const warnings = commands.flatMap((command) => command.warnings)
    return Object.freeze({ commands: Object.freeze(commands), readyToExecute: commands.every((command) => command.approved), warnings: Object.freeze(warnings) })
  }
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
