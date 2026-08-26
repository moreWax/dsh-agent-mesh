/** dsh-agent-mesh composition root: one socket-first SAM capability service. */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import { randomBytes } from "node:crypto"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import type {} from "@deepseek-ai/dsh-credentials/types"
import { SamClient } from "@morewax/sam-mesh"
import { SamNodeManager } from "@morewax/sam-mesh/node"
import { AGENT_MESH_NS, AgentMeshSettingsSchema, nodeDecisionsOf, settingsBaseFromConfig, type AgentMeshSettings } from "./settings.js"
import { SamToolClient } from "./tools/index.js"
import { SamInferenceClient } from "./inference/index.js"
import { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
import { AgentMeshWebHost } from "./web/host.js"
import type { AgentMeshConfigInput, AgentMeshStatusService, MeshCheckup, SetupOptions, SetupPlan } from "./operator/index.js"

export const name = "agent-mesh"
export const provide = ["agentMesh", "agentMeshStatus"]
export const inject = ["credentials", "settings"]
export type Config = AgentMeshConfigInput
export const Config: z<Config> = z.object({
  socketPath: z.union([z.string(), z.const(false)]).default("~/.config/sam-mesh/sam.sock"),
  tcpUrl: z.string().default("http://127.0.0.1:8080"),
  preferSocket: z.boolean().default(true),
  nodeCredentialRef: z.string(),
  /** Reference to a pre-shared enrollment token in the credential store; set = unattended bootstrap enrollment, unset = interactive device flow. */
  nodeEnrollmentCredentialRef: z.string(),
  timeoutMs: z.natural().default(30_000),
  /** Start an already-enrolled node daemon when the plugin boots (identity was human-granted at enrollment). Default true. */
  autoStartNode: z.boolean().default(true),
  /** On an unenrolled machine, begin device-flow enrollment at boot so the card shows the URL/code immediately. Completion always requires human browser authorization. Default true. */
  autoBeginEnrollment: z.boolean().default(true),
  /** Control plane for enrollment; defaults to the manager's (https://hub.sam-mesh.dev). */
  nodeControlPlane: z.string(),
  /** Stop the node when dsh shuts down — but only if dsh started it. Default true. */
  stopNodeOnExit: z.boolean().default(true),
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
export interface AutoNodeOutcome { started: boolean; enrollmentSessionId: string | null }

export interface AutoNodeDeps {
  /** Provision/return the managed local-channel credential (node api-token). */
  ensureNodeToken?: () => Promise<string | undefined>
  /** Return the pre-shared enrollment token when one is stored (bootstrap mode). */
  resolveEnrollmentToken?: () => Promise<string | undefined>
  /** Bound for bootstrap enrollment before it is cancelled (default 60s). */
  bootstrapTimeoutMs?: number
}

export async function autoNode(nodes: SamNodeManager, config: { autoStartNode?: boolean; autoBeginEnrollment?: boolean; nodeControlPlane?: string }, deps: AutoNodeDeps, log: (line: string) => void): Promise<AutoNodeOutcome> {
  const status = await nodes.status()
  const outcome: AutoNodeOutcome = { started: false, enrollmentSessionId: null }
  if (!status.installed) { log(`sam-node not installed; mesh features stay degraded until it is (node kit: npx @morewax/sam-mesh node status)`) ; return outcome }
  if (status.enrolled && !status.running && config.autoStartNode !== false) {
    const apiToken = await deps.ensureNodeToken?.()
    const started = await nodes.start(apiToken !== undefined ? { apiToken } : {})
    if (started.ok) { outcome.started = true; log(`sam-node auto-started: ${started.message}`) }
    else log(`sam-node auto-start failed: ${started.error}`)
  }
  if (!status.enrolled && config.autoBeginEnrollment !== false) {
    const bootstrapToken = await deps.resolveEnrollmentToken?.()
    const options: { controlPlane?: string; bootstrapToken?: string } = {}
    if (config.nodeControlPlane) options.controlPlane = config.nodeControlPlane
    if (bootstrapToken !== undefined) options.bootstrapToken = bootstrapToken
    const session = nodes.beginEnrollment(options)
    outcome.enrollmentSessionId = session.sessionId
    if (bootstrapToken === undefined) {
      log(`machine not enrolled: enrollment session ${session.sessionId} begun — authorize in the browser (Settings → Agent Mesh → Mesh node)`)
      return outcome
    }
    // Bootstrap mode is unattended by design: await completion (bounded), then
    // chain straight into start so a fresh machine comes fully online alone.
    const timeoutMs = deps.bootstrapTimeoutMs ?? 60_000
    const timedOut = await Promise.race([
      session.done.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
    ])
    if (timedOut) session.cancel()
    const info = session.info()
    if (info.state !== 'complete') {
      log(`bootstrap enrollment did not complete (${info.state})${info.error ? `: ${info.error}` : ''}`)
      return outcome
    }
    log('bootstrap enrollment complete')
    const apiToken = await deps.ensureNodeToken?.()
    const started = await nodes.start(apiToken !== undefined ? { apiToken } : {})
    if (started.ok) { outcome.started = true; log(`sam-node auto-started after enrollment: ${started.message}`) }
    else log(`sam-node auto-start after enrollment failed: ${started.error}`)
  }
  return outcome
}

export function apply(ctx: Context, input: Config): void {
  const config = parseAgentMeshConfig(input)
  const resolveNodeToken = config.nodeCredentialRef
    ? async () => (await ctx.credentials.resolve(credentialRef(config.nodeCredentialRef!)))?.value
    : undefined
  /**
   * Provision the managed local-channel credential: the store is the single
   * source — a configured-but-empty ref self-provisions once (generate + set),
   * and the read-back converges racing provisioners onto one stored value.
   */
  const ensureNodeToken = config.nodeCredentialRef
    ? async (): Promise<string | undefined> => {
        const ref = credentialRef(config.nodeCredentialRef!)
        const existing = (await ctx.credentials.resolve(ref))?.value
        if (existing) return existing
        await ctx.credentials.set(ref, randomBytes(32).toString('hex'))
        return (await ctx.credentials.resolve(ref))?.value
      }
    : undefined
  const core = new SamClient({ ...(config.socketPath !== undefined ? { socketPath: config.socketPath } : {}), tcpUrl: config.tcpUrl, preferSocket: config.preferSocket, timeoutMs: config.timeoutMs, ...(resolveNodeToken ? { resolveNodeToken } : {}) })
  const operator = new SamOperator(core)
  const service = { core, tools: new SamToolClient(core), inference: new SamInferenceClient(core), operator }
  ctx.provide("agentMesh", service)
  // The agent-mesh settings namespace: row config is the composition base,
  // user edits from Settings → Plugins persist to settings.yaml and layer on
  // top. Boot-time keys apply on next start (applies: 'restart'); decision-time
  // keys are read live from the scope.
  const scope = ctx.settings.register(AGENT_MESH_NS, AgentMeshSettingsSchema, {
    base: settingsBaseFromConfig(config),
    applies: 'restart',
  })
  const settings = (): AgentMeshSettings => scope.get()

  /**
   * The pre-shared enrollment credential, resolved live: the ref NAME comes
   * from settings (card-editable, '' = interactive device flow), the VALUE
   * from the managed credential store. Value never leaves this process.
   */
  const resolveEnrollmentToken = async (): Promise<string | undefined> => {
    const ref = settings().nodeEnrollmentCredentialRef
    if (!ref) return undefined
    return (await ctx.credentials.resolve(credentialRef(ref)))?.value
  }

  const dir = dataDirOf(config.socketPath)
  const nodes = new SamNodeManager(dir ? { dataDir: dir } : {})
  const ownership: NodeOwnership = { startedByUs: false }
  new AgentMeshWebHost(ctx, service, nodes, ownership, settings, resolveEnrollmentToken, ensureNodeToken)
  ctx.provide("agentMeshStatus", new CordisMeshStatus(operator))
  void autoNode(nodes, nodeDecisionsOf(settings()), { ...(ensureNodeToken ? { ensureNodeToken } : {}), resolveEnrollmentToken }, (line) => ctx.logger("agent-mesh").info(line))
    .then((outcome) => { ownership.startedByUs = outcome.started })
    .catch((error: unknown) => ctx.logger("agent-mesh").warn(`auto-node failed: ${error instanceof Error ? error.message : String(error)}`))
  // Option A: dsh owns what it starts. A node that was already running when
  // dsh booted is external and is left alone on shutdown. stopNodeOnExit is
  // read live: a user toggling it in Settings takes effect without a restart.
  ctx.effect(() => async () => {
    if (!ownership.startedByUs || !settings().stopNodeOnExit) return
    const stopped = await nodes.stop()
    if (stopped.ok) ctx.logger("agent-mesh").info(`dsh shutting down: ${stopped.message}`)
    else ctx.logger("agent-mesh").info(`dsh shutdown: node stop failed: ${stopped.error}`)
  })
}

/** Shared mutable lifecycle ownership: set by auto-start or the card's Start button. */
export interface NodeOwnership { startedByUs: boolean }
export { SamClient, SamCoreClient } from "@morewax/sam-mesh"
export { SamToolClient } from "./tools/index.js"
export { SamInferenceClient } from "./inference/index.js"
export { TaskClient } from "./tasks/index.js"
export { SamOperator, parseAgentMeshConfig } from "./operator/index.js"
export type { AgentMeshStatusService } from "./operator/index.js"

export { MeshObservability, defaultObservability } from "./observability/index.js"
export type { MetricsSnapshot, MetricPoint, AuditEvent, AuditSink } from "./observability/index.js"
