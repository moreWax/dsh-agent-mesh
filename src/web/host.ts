import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Context } from "@deepseek-ai/cordis"
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol"
import type { AgentMeshService } from "../index.js"
import type { ServiceRegistrationRequest, SkillInstallRequest } from "../operator/index.js"

const execFileAsync = promisify(execFile)
export interface MeshDashboardSnapshot {
  transport: { kind: "unix" | "tcp"; endpoint: string }
  mesh?: unknown; network?: unknown; token?: unknown
  services: unknown[]; tools: unknown[]; models: unknown[]; tasks: unknown[]; logs: unknown[]
  failures: { probe: string; message: string }[]; capturedAt: string
}
export interface ApprovedAction { approved: boolean; approvedBy?: string }
export type ActionResult = { ok: true; message: string; value?: unknown } | { ok: false; error: string }

export class AgentMeshWebHost extends TypertRemoteService {
  constructor(ctx: Context, private readonly mesh: AgentMeshService) { super(ctx, "agentMeshWeb") }

  @Remote("snapshot")
  async snapshot(): Promise<MeshDashboardSnapshot> {
    const probes = {
      mesh: () => this.mesh.core.getMeshInfo(), network: () => this.mesh.operator.connectivity(),
      token: () => this.mesh.operator.tokenStatus(), services: () => this.mesh.operator.services(),
      tools: () => this.mesh.core.findRemoteTools(), models: () => this.mesh.core.listModels().then(x => x.data),
      tasks: () => this.mesh.core.callTool<unknown[]>("task_list", {}).catch(() => []),
      logs: () => this.mesh.operator.recentLogs({ limit: 100 }),
    }
    const entries = Object.entries(probes)
    const settled = await Promise.allSettled(entries.map(([, probe]) => probe()))
    const data: Record<string, unknown> = {}; const failures: { probe: string; message: string }[] = []
    settled.forEach((value, i) => { const key = entries[i]![0]; if (value.status === "fulfilled") data[key] = value.value; else failures.push({ probe: key, message: value.reason instanceof Error ? value.reason.message : String(value.reason) }) })
    return {
      transport: this.mesh.core.socketPath ? { kind: "unix", endpoint: this.mesh.core.socketPath } : { kind: "tcp", endpoint: this.mesh.core.baseUrl },
      mesh: data.mesh, network: data.network, token: data.token,
      services: (data.services as unknown[] | undefined) ?? [], tools: (data.tools as unknown[] | undefined) ?? [], models: (data.models as unknown[] | undefined) ?? [], tasks: (data.tasks as unknown[] | undefined) ?? [], logs: (data.logs as unknown[] | undefined) ?? [], failures, capturedAt: new Date().toISOString(),
    }
  }

  @Remote("check") async check(): Promise<MeshDashboardSnapshot> { return this.snapshot() }
  @Remote("startNode") async startNode(approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    try { await execFileAsync("sam-node", ["run", "--daemon"], { timeout: 30_000 }); return { ok: true, message: "sam-node start requested" } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  @Remote("installSkill") async installSkill(request: SkillInstallRequest, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const plan = this.mesh.operator.planSkillInstall(request)
    try { await execFileAsync(plan.command.executable, [...plan.command.args], { timeout: 120_000 }); return { ok: true, message: `Installed skill from ${request.source}` } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  @Remote("registerService") async registerService(request: ServiceRegistrationRequest, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    try { return { ok: true, message: `Registered ${request.name}`, value: await this.mesh.operator.registerService(request) } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  @Remote("deviceFlowInstructions") async deviceFlowInstructions(): Promise<string[]> {
    return ["Open a terminal on the host running DeepSeek Harness.", "Run: sam-node enroll", "Open the verification URL printed by sam-node and enter its one-time code.", "Return here and select Check connection. Credentials and device codes are never accepted by this web page."]
  }
}
