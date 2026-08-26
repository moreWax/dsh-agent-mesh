import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { SamNodeManager, type EnrollmentInfo, type NodeStatus } from "@morewax/sam-mesh/node"
import { buildChecks, decodeFleetInvite, mergeProfilePatch, fleetProfilePatch, type DoctorCheck, type FleetInvite } from "@morewax/sam-mesh/plan"
import { generatePairKeys, open } from "@morewax/sam-mesh"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import type { NodeOwnership } from "../index.js"
import type { AgentMeshSettings } from "../settings.js"
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
  constructor(ctx: Context, private readonly mesh: AgentMeshService, private readonly nodes = new SamNodeManager(), private readonly ownership: NodeOwnership = { startedByUs: false }, private readonly settings: () => AgentMeshSettings = () => ({ autoStartNode: true, autoBeginEnrollment: true, stopNodeOnExit: true, nodeControlPlane: "", nodeBinary: "", nodeEnrollmentCredentialRef: "", tcpUrl: "", timeoutMs: 30_000, preferSocket: true, socketPath: false }), private readonly resolveEnrollmentToken: () => Promise<string | undefined> = async () => undefined, private readonly ensureNodeToken: () => Promise<string | undefined> = async () => undefined) { super(ctx, "agentMeshWeb") }

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

  /** Every usable sam-node on this machine + the current selection. The
   * suggestion is marked; the card renders the dropdown from this. */
  @Remote("nodeBinaryOptions") async nodeBinaryOptions(): Promise<{
    options: Array<{ path: string; source: 'env' | 'bundled' | 'path'; suggested: boolean; tag?: string }>
    selected: string
    auto: boolean
  }> {
    const options = await this.nodes.binaryOptions()
    const selected = this.settings().nodeBinary
    const suggested = options.find(o => o.suggested)
    // '' (auto) effectively resolves to the suggestion — reflect that so the
    // card can show "Auto (bundled v0.1.0-alpha.7)" as the current value.
    return { options, selected: selected || suggested?.path || '', auto: !selected }
  }

  @Remote("startNode") async startNode(approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const apiToken = await this.ensureNodeToken()
    const started = await this.nodes.start(apiToken !== undefined ? { apiToken } : {})
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
    // Live settings read: a control plane saved in Settings applies without a restart.
    const configured = this.settings().nodeControlPlane
    // A stored pre-shared token upgrades any enrollment (card or auto) to
    // unattended bootstrap; without one the interactive device flow stands.
    const bootstrapToken = await this.resolveEnrollmentToken()
    const session = this.nodes.beginEnrollment({ ...(configured ? { controlPlane: configured } : {}), ...(bootstrapToken !== undefined ? { bootstrapToken } : {}), ...(options ?? {}) })
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
  /**
   * The same checks as `sam-mesh doctor`, surfaced for the card's onboarding
   * wizard. Ungated read: it only probes local state.
   */
  @Remote("meshDoctor") async meshDoctor(): Promise<{ checks: DoctorCheck[] }> {
    const status = await this.nodes.status()
    let peerCount: number | undefined
    let serviceCount: number | undefined
    let localServiceCount = 0
    if (status.running) {
      try {
        const mesh = await this.mesh.core.getMeshInfo()
        peerCount = Array.isArray(mesh.connected_peers) ? mesh.connected_peers.length : 0
        const remote = await this.mesh.core.discoverRemoteServices({ type: "mcp" })
        serviceCount = remote.length
        localServiceCount = (await this.mesh.core.listLocalServices()).length
      } catch { peerCount = undefined }
    }
    const checks = buildChecks({ installed: status.installed, enrolled: status.enrolled, running: status.running, peerCount, serviceCount, localServiceCount })
    if (status.enrolled && status.enrolledHub) {
      const enrolledCheck = checks.find(c => c.name === "enrolled on a hub")
      if (enrolledCheck) enrolledCheck.detail = status.enrolledHub
    }
    if (status.installed && status.binarySource) {
      const binaryCheck = checks.find(c => c.name === "sam-node binary")
      if (binaryCheck) binaryCheck.detail = status.binarySource === "bundled" ? "carried by the package" : `${status.binarySource}: ${status.binaryPath}`
    }
    return { checks }
  }

  // ─── join a fleet FROM this machine (the complete-UI path) ──────────────

  private readonly pairSessions = new Map<string, { fleet: string; requestId: string; state: "waiting" | "complete" | "failed"; error?: string; notes?: string[]; privateKey: import("node:crypto").KeyObject; timer: ReturnType<typeof setInterval> }>()

  /** Browse fleets in the swarm: service names with provider counts. Ungated
   * read. Carries the LOCAL node's posture so the card can render guidance
   * when the list is empty — an unenrolled node or one enrolled on a
   * DIFFERENT hub (e.g. a stale private-hub identity) sees an empty swarm
   * here, and "No fleets visible" alone never says why. */
  @Remote("fleetDiscover") async fleetDiscover(): Promise<{
    fleets: { name: string; providers: number; peerIds: string[] }[]
    node: { running: boolean; enrolled: boolean; enrolledHub: string | null }
  }> {
    const services = await this.mesh.core.discoverRemoteServices({ type: "mcp" })
    const byName = new Map<string, string[]>()
    for (const s of services) {
      if (typeof s.srv_name !== "string" || typeof s.peer_id !== "string" || !s.srv_name || !s.peer_id) continue
      byName.set(s.srv_name, [...(byName.get(s.srv_name) ?? []), s.peer_id])
    }
    const status = await this.nodes.status()
    return {
      fleets: [...byName.entries()].map(([name, peerIds]) => ({ name, providers: peerIds.length, peerIds })),
      node: { running: status.running, enrolled: status.enrolled, enrolledHub: status.enrolledHub },
    }
  }

  /**
   * Request to join a discovered fleet. The HOST owns the pairing session
   * (ephemeral keypair, polling, sealed-invite opening, provisioning) — the
   * card only watches status. Gated like enrollment: joining a fleet is an
   * identity-relevant act.
   */
  @Remote("requestFleetPair") async requestFleetPair(request: { serviceName: string; peerId?: string; label?: string }, approval: ApprovedAction): Promise<{ sessionId?: string; ok: boolean; error?: string }> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const providers = (await this.mesh.core.discoverRemoteServices({ type: "mcp", name: request.serviceName })).filter(s => s.srv_name === request.serviceName)
    const provider = request.peerId ? providers.find(p => p.peer_id === request.peerId || p.peer_id?.startsWith(request.peerId!)) : providers[0]
    if (!provider?.peer_id) return { ok: false, error: providers.length === 0 ? `No provider of '${request.serviceName}' in the swarm` : `No provider matching '${request.peerId}'` }
    const keys = generatePairKeys()
    const requestId = randomBytes(16).toString("hex")
    const sessionId = randomBytes(8).toString("hex")
    const label = request.label?.trim() || `dsh@${(await import("node:os")).hostname()}`
    try {
      await this.mesh.core.callRemoteTool({ peer_id: provider.peer_id, tool_name: `mcp://${request.serviceName}/fleet_pair_request`, arguments: { requestId, publicKey: keys.publicKeyX, label } })
    } catch (error) { return { ok: false, error: `pair request failed: ${error instanceof Error ? error.message : String(error)}` } }
    const session = { fleet: request.serviceName, requestId, state: "waiting" as const, privateKey: keys.privateKey, timer: undefined as unknown as ReturnType<typeof setInterval> }
    this.pairSessions.set(sessionId, session)
    const startedAt = Date.now()
    session.timer = setInterval(() => { void this.pollPairSession(sessionId, provider.peer_id!, startedAt) }, 2000)
    return { ok: true, sessionId }
  }

  private async pollPairSession(sessionId: string, peerId: string, startedAt: number): Promise<void> {
    const session = this.pairSessions.get(sessionId)
    if (!session || session.state !== "waiting") return
    if (Date.now() - startedAt > 10 * 60_000) return this.failPairSession(sessionId, "Timed out waiting for operator approval")
    let poll: { state: string; sealed?: Parameters<typeof open>[0] }
    try { poll = await this.mesh.core.callRemoteTool({ peer_id: peerId, tool_name: `mcp://${session.fleet}/fleet_pair_poll`, arguments: { requestId: session.requestId } }) as typeof poll }
    catch { return } // transient mesh errors keep polling
    if (poll.state === "unknown") return this.failPairSession(sessionId, "Request expired or was rejected")
    if (poll.state !== "approved" || !poll.sealed) return
    try {
      const decoded = decodeFleetInvite(open(poll.sealed, session.privateKey))
      if ("error" in decoded) return this.failPairSession(sessionId, `Approval carried an invalid invite: ${decoded.error}`)
      const notes = await this.provisionFleetMembership(decoded)
      session.state = "complete"; session.notes = notes
    } catch (error) { return this.failPairSession(sessionId, `provisioning failed: ${error instanceof Error ? error.message : String(error)}`) }
    clearInterval(session.timer)
  }

  private failPairSession(sessionId: string, error: string): void {
    const session = this.pairSessions.get(sessionId)
    if (!session) return
    session.state = "failed"; session.error = error
    clearInterval(session.timer)
  }

  /** What a fleet membership means for THIS dsh machine, applied in-process. */
  private async provisionFleetMembership(invite: FleetInvite): Promise<string[]> {
    const notes: string[] = []
    // 1. managed credential store — the plugin's per-call resolver picks it
    //    up IMMEDIATELY (agent calls to fleet services work, no restart).
    await this.ctx.credentials.set(credentialRef("MESH_TASK_CAPABILITY"), invite.capability)
    notes.push("fleet capability stored (managed store) — agent calls to fleet services work now")
    // 2. CLI parity file for the standalone sam-mesh on this machine.
    try {
      const capPath = join(homedir(), ".config", "sam-mesh", "fleet-capability")
      await mkdir(join(capPath, ".."), { recursive: true })
      await writeFile(capPath, invite.capability, { mode: 0o600 }); await chmod(capPath, 0o600)
      notes.push(`CLI parity: ${capPath} (0600)`)
    } catch (error) { notes.push(`CLI parity file failed: ${error instanceof Error ? error.message : String(error)}`) }
    // 3. profile patch so a RESTART keeps the posture (gate your own task
    //    service with the same fleet capability).
    try {
      const profile = process.env.DSH_PROFILE ?? "web"
      const patchPath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", profile, "cordis.patch.yml")
      const existing = await readFile(patchPath, "utf8").catch(() => null)
      const merged = mergeProfilePatch(existing, invite)
      if ("conflict" in merged) notes.push(merged.conflict)
      else { await mkdir(join(patchPath, ".."), { recursive: true }); await writeFile(patchPath, merged.text); notes.push(`profile patch updated (${patchPath}) — restart dsh to gate your own task service`) }
    } catch (error) { notes.push(`profile patch failed: ${error instanceof Error ? error.message : String(error)}`) }
    return notes
  }

  /** Watch a pairing session. Ungated read. */
  @Remote("fleetPairStatus") async fleetPairStatus(sessionId: string): Promise<{ state: string; fleet?: string; error?: string; notes?: string[] }> {
    const session = this.pairSessions.get(sessionId)
    if (!session) return { state: "unknown" }
    return { state: session.state, fleet: session.fleet, ...(session.error ? { error: session.error } : {}), ...(session.notes ? { notes: session.notes } : {}) }
  }

  /** Pending fleet pair requests — the card's approval queue. Ungated read,
   * same sensitivity class as nodeStatus; the web surface is dsh-authenticated. */
  @Remote("pairRequests") async pairRequests(): Promise<{ pairing: boolean; pending: unknown[] }> {
    const tasks = this.taskService()
    if (!tasks?.pairing) return { pairing: false, pending: [] }
    return { pairing: true, pending: tasks.pairPending() }
  }

  /** Operator approval: seals the fleet invite to the requester. Gated —
   * this is the human gate of the whole pairing protocol. */
  @Remote("approvePairRequest") async approvePairRequest(requestId: string, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const tasks = this.taskService()
    if (!tasks?.pairing) return { ok: false, error: "Pairing is not armed on this machine (no capability gate configured)" }
    try {
      const approved = tasks.pairApprove(requestId, approval.approvedBy.trim())
      return { ok: true, message: `Approved '${approved.label}' — invite sealed and delivered` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Reject a pending request. Gated like approval — it mutates the queue. */
  @Remote("rejectPairRequest") async rejectPairRequest(requestId: string, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const tasks = this.taskService()
    if (!tasks?.pairing) return { ok: false, error: "Pairing is not armed on this machine (no capability gate configured)" }
    return tasks.pairReject(requestId)
      ? { ok: true, message: "Request rejected" }
      : { ok: false, error: "No such pending request (expired or already handled)" }
  }

  /** Lazy access: the task-service plugin may be unmounted or still booting. */
  private taskService(): import("../tasks/service.js").TaskService | undefined {
    try { return this.ctx.agentMeshTaskService } catch { return undefined }
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
