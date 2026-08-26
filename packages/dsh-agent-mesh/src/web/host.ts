import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { SamNodeManager, type EnrollmentInfo, type NodeStatus } from "@morewax/sam-mesh/node"
import type { NodeOwnership } from "../index.js"
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
export type NodeStatusView = NodeStatus & { managedByDsh: boolean }
export type ActionResult = { ok: true; message: string; value?: unknown } | { ok: false; error: string }

export class AgentMeshWebHost extends TypertRemoteService {
  constructor(ctx: Context, private readonly mesh: AgentMeshService, private readonly nodes = new SamNodeManager(), private readonly ownership: NodeOwnership = { startedByUs: false }) { super(ctx, "agentMeshWeb") }

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
  /** Node status plus lifecycle ownership: managedByDsh means quitting dsh stops the node. */
  @Remote("nodeStatus") async nodeStatus(): Promise<NodeStatusView> {
    return { ...await this.nodes.status(), managedByDsh: this.ownership.startedByUs }
  }

  @Remote("startNode") async startNode(approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const started = await this.nodes.start()
    // A start initiated from dsh (here or the boot auto-start) makes the node
    // dsh-managed: it stops when dsh stops. An already-running node stays external.
    if (started.ok && !started.message.includes("already running")) this.ownership.startedByUs = true
    return started
  }

  @Remote("stopNode") async stopNode(approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    return this.nodes.stop()
  }

  /**
   * Begin OIDC device-flow enrollment of THIS machine as a mesh node. The
   * returned info carries the verification URL and user code once sam-node
   * prints them; the card polls enrollmentStatus until the user authorizes
   * in the browser. Joining a mesh is an identity-trust decision, so it is
   * approval-gated like every other mutation here.
   */
  @Remote("beginEnrollment") async beginEnrollment(approval: ApprovedAction, options?: { controlPlane?: string }): Promise<EnrollmentInfo | ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const status = await this.nodes.status()
    if (!status.installed) return { ok: false, error: "sam-node is not installed or not on PATH" }
    if (status.enrolled) return { ok: false, error: `This machine already has a node identity in ${status.dataDir}; reset stays a deliberate terminal operation.` }
    const session = this.nodes.beginEnrollment(options ?? {})
    // Give the child a brief moment to print the device-flow block so the
    // first card render usually already shows the URL and code.
    const deadline = Date.now() + 5_000
    while (session.state === "starting" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return session.info()
  }

  @Remote("enrollmentStatus") async enrollmentStatus(sessionId: string): Promise<EnrollmentInfo | null> {
    return this.nodes.enrollment(sessionId)
  }

  /** The in-flight enrollment a card should surface on load (e.g. one auto-begun at boot). */
  @Remote("activeEnrollment") async activeEnrollment(): Promise<EnrollmentInfo | null> {
    return this.nodes.activeEnrollment()
  }

  /** Cancel an in-flight enrollment. Abort-only (never grants anything), so ungated. */
  @Remote("cancelEnrollment") async cancelEnrollment(sessionId: string): Promise<ActionResult> {
    return this.nodes.cancelEnrollment(sessionId)
      ? { ok: true, message: "Enrollment cancelled" }
      : { ok: false, error: "No such enrollment session (already finished or expired)" }
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
