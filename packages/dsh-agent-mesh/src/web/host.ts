import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { SamNodeManager, type EnrollmentInfo, type NodeStatus } from "@morewax/sam-mesh/node"
import { buildChecks, decodeFleetInvite, mergeProfilePatch, fleetProfilePatch, type DoctorCheck, type FleetInvite } from "@morewax/sam-mesh/plan"
import { generatePairKeys, open } from "@morewax/sam-mesh"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { existsSync } from "node:fs"
export interface ServeStatusView { configured: boolean; target: string; port: number; announceName: string; modelAllowlist: string[]; runtimeModel: string; running: boolean; models: string[]; rowState?: string | undefined; rowDetail?: string | undefined; backends: Array<{ name: string; url: string; present: boolean }> }
export interface ServeConfigureRequest { enabled: boolean; target?: string; announceName?: string; modelAllowlist?: string[]; runtimeModel?: string; runtimeAlias?: string }
export interface RuntimeStatusView { available: boolean; tag?: string; error?: string; models: Array<{ file: string; bytes: number }> }
export interface RuntimePullView { sessionId: string }
export interface RuntimePullStatusView { state: 'running' | 'done' | 'failed'; downloaded: number; total?: number; path?: string; error?: string }
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

  /** Unwrap an MCP tool envelope: callRemoteTool returns { content, structuredContent } —
   *  reading fields off the envelope is the classic silent-failure (state/pending/members
   *  read as undefined while the call succeeds). Payload-first, envelope as fallback. */
  private static toolPayload<T extends Record<string, unknown>>(result: unknown): T {
    if (typeof result === "object" && result !== null) {
      const structured = (result as { structuredContent?: unknown }).structuredContent
      if (structured && typeof structured === "object") return structured as T
      return result as T
    }
    return {} as T
  }

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

  private readonly pullSessions = new Map<string, RuntimePullStatusView>()
  private readonly pairSessions = new Map<string, { fleet: string; requestId: string; state: "waiting" | "complete" | "failed"; error?: string; notes?: string[]; privateKey: import("node:crypto").KeyObject; timer: ReturnType<typeof setInterval> }>()

  /** Browse fleets in the swarm: service names with provider counts. Ungated
   * read. Carries the LOCAL node's posture so the card can render guidance
   * when the list is empty — an unenrolled node or one enrolled on a
   * DIFFERENT hub (e.g. a stale private-hub identity) sees an empty swarm
   * here, and "No fleets visible" alone never says why. */
  @Remote("fleetDiscover") async fleetDiscover(): Promise<{
    fleets: { name: string; providers: number; peerIds: string[] }[]
    node: { running: boolean; enrolled: boolean; enrolledHub: string | null }
    /** C1: the trust watcher escalated an unhealable identity — the card shows a persistent re-approval banner. */
    needsReenroll: boolean
    /** C3: fleet membership posture, probed live (valid capability / stale / unpaired). */
    membership: { state: "valid" | "stale" | "unpaired"; detail?: string }
  }> {
    const services = await this.mesh.core.discoverRemoteServices({ type: "mcp" })
    const byName = new Map<string, string[]>()
    for (const s of services) {
      if (typeof s.srv_name !== "string" || typeof s.peer_id !== "string" || !s.srv_name || !s.peer_id) continue
      byName.set(s.srv_name, [...(byName.get(s.srv_name) ?? []), s.peer_id])
    }
    const status = await this.nodes.status()
    // C1: the A1 watcher's escalation marker.
    const needsReenroll = existsSync(join(homedir(), ".config", "sam-mesh", "needs-reenroll.txt"))
    // C3: membership validity, probed with a 4s bound — a stale capability must
    // surface HERE, not as a mysterious denial stream in the fleet channel.
    let membership: { state: "valid" | "stale" | "unpaired"; detail?: string }
    const capability = await this.mesh.resolveCallCapability?.()
    if (!capability) membership = { state: "unpaired", detail: "no fleet capability on this machine — join a fleet" }
    else {
      // escha's own fleet service is never self-listed; member replicas
      // ('-member') are NOT the fleet — probing them with our capability is a
      // guaranteed false 'stale'. A machine that HOSTS the fleet is valid by
      // construction; consumers probe the real (non-member) entry.
      const localServices = await this.mesh.core.listLocalServices().catch(() => [] as Array<{ name?: string }>)
      const hostsFleet = localServices.some(s => typeof s.name === "string" && s.name.endsWith("task-service") && !s.name.endsWith("-member"))
      const fleet = hostsFleet ? undefined : services.find(s => typeof s.srv_name === "string" && s.srv_name.endsWith("task-service") && !s.srv_name.endsWith("-member") && s.peer_id)
      if (hostsFleet) membership = { state: "valid", detail: "this machine operates the fleet" }
      else if (!fleet?.peer_id) membership = { state: "stale", detail: "capability stored but no fleet service visible to probe" }
      else {
        try {
          await this.mesh.core.callRemoteTool({ peer_id: fleet.peer_id, tool_name: `mcp://${fleet.srv_name}/chat_fetch`, arguments: { limit: 1, _capability: capability } }, AbortSignal.timeout(4_000))
          membership = { state: "valid", detail: "capability verified against the fleet" }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          membership = { state: "stale", detail: /capability/i.test(message) ? "capability rejected — re-provision (Join a fleet with a fresh invite code)" : `probe failed: ${message}` }
        }
      }
    }
    return {
      fleets: [...byName.entries()].map(([name, peerIds]) => ({ name, providers: peerIds.length, peerIds })),
      node: { running: status.running, enrolled: status.enrolled, enrolledHub: status.enrolledHub },
      needsReenroll,
      membership,
    }
  }

  /**
   * Request to join a discovered fleet. The HOST owns the pairing session
   * (ephemeral keypair, polling, sealed-invite opening, provisioning) — the
   * card only watches status. Gated like enrollment: joining a fleet is an
   * identity-relevant act.
   */
  @Remote("requestFleetPair") async requestFleetPair(request: { serviceName: string; peerId?: string; label?: string; inviteCode?: string }, approval: ApprovedAction): Promise<{ sessionId?: string; ok: boolean; error?: string }> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const providers = (await this.mesh.core.discoverRemoteServices({ type: "mcp", name: request.serviceName })).filter(s => s.srv_name === request.serviceName)
    const provider = request.peerId ? providers.find(p => p.peer_id === request.peerId || p.peer_id?.startsWith(request.peerId!)) : providers[0]
    if (!provider?.peer_id) return { ok: false, error: providers.length === 0 ? `No provider of '${request.serviceName}' in the swarm` : `No provider matching '${request.peerId}'` }
    const keys = generatePairKeys()
    const requestId = randomBytes(16).toString("hex")
    const sessionId = randomBytes(8).toString("hex")
    const label = request.label?.trim() || `dsh@${(await import("node:os")).hostname()}`
    try {
      await this.mesh.core.callRemoteTool({ peer_id: provider.peer_id, tool_name: `mcp://${request.serviceName}/fleet_pair_request`, arguments: { requestId, publicKey: keys.publicKeyX, label, ...(request.inviteCode?.trim() ? { inviteCode: request.inviteCode.trim() } : {}) } })
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
    try { poll = AgentMeshWebHost.toolPayload<typeof poll>(await this.mesh.core.callRemoteTool({ peer_id: peerId, tool_name: `mcp://${session.fleet}/fleet_pair_poll`, arguments: { requestId: session.requestId } })) }
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
      const approved = await tasks.pairApprove(requestId, approval.approvedBy.trim())
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

  /**
   * Fleet administration FROM ANY PAIRED MACHINE: drive the fleet server's
   * operator tools (fleet_pair_list/approve/reject — capability-gated at the
   * service edge) through the mesh. The client no longer needs the server's
   * UI to run the fleet; the capability is what proves operatorship, exactly
   * as if the action were taken on the server itself. First pairing still
   * bootstraps at the source (the capability has to originate somewhere).
   */
  @Remote("fleetAdminRequests") async fleetAdminRequests(request: { serviceName?: string; peerId?: string } = {}): Promise<{ ok: boolean; pending?: { requestId: string; label: string; requestedAt?: string }[]; error?: string }> {
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      const result = AgentMeshWebHost.toolPayload<{ pending?: { requestId: string; label: string; requestedAt?: string }[] }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_pair_list`, arguments: { _capability: provider.capability } }))
      return { ok: true, pending: Array.isArray(result?.pending) ? result.pending : [] }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  @Remote("fleetAdminApprove") async fleetAdminApprove(request: { requestId: string; serviceName?: string; peerId?: string }, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      const result = AgentMeshWebHost.toolPayload<{ label?: string }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_pair_approve`, arguments: { _capability: provider.capability, requestId: request.requestId, approvedBy: approval.approvedBy.trim() } }))
      return { ok: true, message: `Approved '${result?.label ?? request.requestId}' on ${provider.service} — invite sealed and delivered` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  @Remote("fleetAdminReject") async fleetAdminReject(request: { requestId: string; serviceName?: string; peerId?: string }, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_pair_reject`, arguments: { _capability: provider.capability, requestId: request.requestId } })
      return { ok: true, message: "Request rejected" }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Fleet members and their scopes (operator). Capabilities are never returned by the service. */
  @Remote("fleetAdminMembers") async fleetAdminMembers(request: { serviceName?: string; peerId?: string } = {}): Promise<{ ok: boolean; members?: { id: string; name: string; scopes: string[]; createdAt: string; note?: string }[]; error?: string }> {
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      const result = AgentMeshWebHost.toolPayload<{ members?: { id: string; name: string; scopes: string[]; createdAt: string; note?: string }[] }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_member_list`, arguments: { _capability: provider.capability } }))
      return { ok: true, members: Array.isArray(result?.members) ? result.members : [] }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Revoke a fleet member — their capability fails on the next gated call (operator). */
  @Remote("fleetAdminRevoke") async fleetAdminRevoke(request: { id: string; serviceName?: string; peerId?: string }, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_member_revoke`, arguments: { _capability: provider.capability, id: request.id } })
      return { ok: true, message: `Member ${request.id} revoked — capability fails on the next gated call` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Live model steering status (capability; the fleet's operator answers). */
  @Remote("inferenceSteerStatus") async inferenceSteerStatus(request: { row?: string; serviceName?: string; peerId?: string } = {}): Promise<{ ok: boolean; rows?: Record<string, { systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number }>; error?: string }> {
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      const result = AgentMeshWebHost.toolPayload<{ rows?: Record<string, { systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number }> }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/inference_steer_status`, arguments: { _capability: provider.capability, ...(request.row ? { row: request.row } : {}) } }))
      return { ok: true, rows: result.rows ?? {} }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Apply live steering to a served model (operator; every field optional; clear resets). */
  @Remote("inferenceSteerApply") async inferenceSteerApply(request: { row?: string; systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number; clear?: boolean; serviceName?: string; peerId?: string }, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      const result = AgentMeshWebHost.toolPayload<{ steered?: string }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/inference_steer`, arguments: { _capability: provider.capability, ...(request.row ? { row: request.row } : {}), ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.topP !== undefined ? { topP: request.topP } : {}), ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}), ...(request.clear === true ? { clear: true } : {}) } }))
      return { ok: true, message: `Steering live on ${result.steered ?? request.row ?? 'default row'} — takes effect on the next request` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Generate a one-time invite code: possession is the approval (operator). */
  @Remote("fleetInviteCreate") async fleetInviteCreate(request: { ttlMs?: number; note?: string; serviceName?: string; peerId?: string }, approval: ApprovedAction): Promise<{ ok: boolean; code?: string; expiresAt?: number; error?: string }> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    const provider = await this.fleetAdminProvider(request)
    if (typeof provider === "string") return { ok: false, error: provider }
    try {
      const result = AgentMeshWebHost.toolPayload<{ code?: string; expiresAt?: number }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_invite_create`, arguments: { _capability: provider.capability, ...(request.ttlMs ? { ttlMs: request.ttlMs } : {}), ...(request.note ? { note: request.note } : {}) } }))
      if (typeof result.code !== "string") return { ok: false, error: "service returned no code" }
      return { ok: true, code: result.code, ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Resolve the fleet provider + capability for admin calls; string = human error. */
  private async fleetAdminProvider(request: { serviceName?: string; peerId?: string }): Promise<{ peerId: string; service: string; capability: string } | string> {
    const capability = await this.mesh.resolveCallCapability?.()
    if (!capability) return "fleet administration needs the fleet capability — pair this machine first (Agent Mesh card → Discover fleets)"
    const services = await this.mesh.core.discoverRemoteServices({ type: "mcp", ...(request.serviceName ? { name: request.serviceName } : {}) })
    const fleets = services.filter((s): s is typeof s & { srv_name: string; peer_id: string } => typeof s.srv_name === "string" && typeof s.peer_id === "string" && s.srv_name.length > 0 && s.peer_id.length > 0)
    // Operator-chosen prefixes: 'dsh-task-service' may only be a SUFFIX of the
    // swarm name ('morewax-dsh-task-service'). Exact first, suffix fallback.
    const requested = request.serviceName ?? fleets[0]?.srv_name
    const service = requested && fleets.some(f => f.srv_name === requested)
      ? requested
      : fleets.find(f => f.srv_name.endsWith('task-service'))?.srv_name ?? requested
    if (!service) return "no fleet services visible in the swarm"
    const provider = request.peerId
      ? fleets.find(f => f.srv_name === service && (f.peer_id === request.peerId || f.peer_id.startsWith(request.peerId!)))
      : fleets.find(f => f.srv_name === service)
    if (!provider) return `no provider of '${service}' in the swarm`
    return { peerId: provider.peer_id, service, capability }
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

  /** Serve-inference status: card dashboard. Ungated read. */
  @Remote("inferenceServeStatus") async inferenceServeStatus(): Promise<ServeStatusView> {
    const profile = process.env.DSH_PROFILE ?? "web"
    const patchPath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", profile, "cordis.patch.yml")
    const existing = await readFile(patchPath, "utf8").catch(() => "")
    const { readServeConfig, DEFAULT_SERVE_CONFIG } = await import("./serve-patch.js")
    const config = readServeConfig(existing) ?? { ...DEFAULT_SERVE_CONFIG }
    let running = false
    let models: string[] = []
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/v1/models`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) { running = true; const body = await res.json() as { data?: Array<{ id?: unknown }> }; models = (body.data ?? []).flatMap(m => typeof m.id === "string" ? [m.id] : []) }
    } catch { /* not serving right now */ }
    const { WELL_KNOWN_BACKENDS, probeBackend } = await import("@morewax/sam-mesh/node")
    const backends = await Promise.all(WELL_KNOWN_BACKENDS.map(async b => ({ ...b, present: await probeBackend(b).catch(() => false) })))
    const { readServeStatuses } = await import("@morewax/sam-mesh/node")
    const rowStatus = (await readServeStatuses(join(homedir(), ".config", "sam-mesh"))).find(s => s.name === config.announceName)
    return { configured: readServeConfig(existing) !== null, target: config.target, port: config.port, announceName: config.announceName, modelAllowlist: config.modelAllowlist, runtimeModel: config.runtimeModel, running, models, ...(rowStatus ? { rowState: rowStatus.state, ...(rowStatus.detail !== undefined ? { rowDetail: rowStatus.detail } : {}) } : {}), backends }
  }

  /** Vendored-runtime facts for the card: binary availability + model store. Ungated read. */
  @Remote("runtimeStatus") async runtimeStatus(): Promise<RuntimeStatusView> {
    const { resolveVendoredLlama, listModelStore } = await import("@morewax/sam-mesh/node")
    const dataDir = join(homedir(), ".config", "sam-mesh")
    const models = await listModelStore(dataDir)
    try { const v = await resolveVendoredLlama(dataDir); return { available: true, tag: v.tag, models } }
    catch (error) { return { available: false, error: error instanceof Error ? error.message : String(error), models } }
  }

  /** Download a HF model into the store. Explicit + approved (network + GBs). Boot code never downloads. */
  @Remote("runtimePull") async runtimePull(request: { model: string }, approval: ApprovedAction): Promise<RuntimePullView> {
    if (!approval.approved || !approval.approvedBy?.trim()) throw new Error("Explicit approval and approver name are required.")
    const sessionId = randomBytes(6).toString("hex")
    this.pullSessions.set(sessionId, { state: "running", downloaded: 0 })
    void (async () => {
      const { parseModelSpec, downloadModel } = await import("@morewax/sam-mesh/node")
      const dataDir = join(homedir(), ".config", "sam-mesh")
      try {
        const spec = parseModelSpec(request.model)
        if (spec.kind !== "hf") throw new Error("pull needs a Hugging Face ref (org/repo[:quant])")
        const session = this.pullSessions.get(sessionId)!
        const done = await downloadModel(dataDir, spec, { onProgress: (p) => { session.downloaded = p.downloaded; if (p.total !== undefined) session.total = p.total } })
        session.state = "done"; session.path = done.path
      } catch (error) { this.pullSessions.set(sessionId, { state: "failed", downloaded: 0, error: error instanceof Error ? error.message : String(error) }) }
    })()
    return { sessionId }
  }

  /** Watch a pull. Ungated read. */
  @Remote("runtimePullStatus") async runtimePullStatus(sessionId: string): Promise<RuntimePullStatusView> {
    const session = this.pullSessions.get(sessionId)
    if (!session) return { state: "failed", downloaded: 0, error: "unknown session" }
    return { ...session }
  }

  /** Enable/update/disable the serve row. Writes the managed patch block; a restart applies it. */
  @Remote("inferenceServeConfigure") async inferenceServeConfigure(request: ServeConfigureRequest, approval: ApprovedAction): Promise<ActionResult> {
    if (!approval.approved || !approval.approvedBy?.trim()) return { ok: false, error: "Explicit approval and approver name are required." }
    try {
      const profile = process.env.DSH_PROFILE ?? "web"
      const patchPath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", profile, "cordis.patch.yml")
      const existing = await readFile(patchPath, "utf8").catch(() => "")
      const { readServeConfig, writeServeConfig, DEFAULT_SERVE_CONFIG } = await import("./serve-patch.js")
      const current = readServeConfig(existing) ?? { ...DEFAULT_SERVE_CONFIG }
      const next = request.enabled
        ? { ...current, enabled: true, target: request.target?.trim() || current.target, announceName: request.announceName?.trim() || current.announceName, modelAllowlist: request.modelAllowlist ?? current.modelAllowlist, runtimeModel: request.runtimeModel?.trim() ?? current.runtimeModel, runtimeAlias: request.runtimeAlias?.trim() ?? current.runtimeAlias }
        : null
      await mkdir(join(patchPath, ".."), { recursive: true })
      await writeFile(patchPath, writeServeConfig(existing, next))
      return { ok: true, message: request.enabled ? `Serve row written (${next?.target} as ${next?.announceName}) — restart dsh to apply` : "Serve row removed — restart dsh to apply", value: { restartRequired: true } }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
    // scaffold-anchor: host-method (scaffold-remote inserts before this line)
}

