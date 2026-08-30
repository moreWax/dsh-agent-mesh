import { randomBytes } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentMeshService } from '../index.js'
import { InMemoryTaskStore, TaskService, type TaskExecutor } from './service.js'
import { SQLiteTaskStore } from './sqlite.js'
import { withPairing, InviteCodes } from './pairing.js'
import { MemberAuthorizer, ToolAllowlistAuthorizer, type Authorizer } from './authz.js'
import { FleetMemberRegistry, defaultMembersPath, type FleetScope } from './members.js'
import { withMemberTools } from './member-tools.js'
import { peerExecTools } from './exec.js'
import { reconcileServiceName } from './service-name.js'
import { TaskHttpServer } from './http.js'
import { CapabilityAuthorizer } from './authz.js'
import { SamTaskRegistrationClient } from './registration.js'
import type { SamServiceRegistrationClient as Client } from '@morewax/sam-mesh'
/** 2s debounce coalescer: identical keys flush once with their repeat count. */
class AuditCoalescer {
  private readonly pending = new Map<string, { count: number; flush: (count: number) => void; timer: ReturnType<typeof setTimeout> }>()
  add(key: string, flush: (count: number) => void, windowMs = 2000): void {
    const existing = this.pending.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.count += 1
      existing.flush = flush
      existing.timer = setTimeout(() => { this.pending.delete(key); existing.flush(existing.count) }, windowMs)
      existing.timer.unref?.()
      return
    }
    const entry = { count: 1, flush, timer: setTimeout(() => { this.pending.delete(key); flush(1) }, windowMs) }
    entry.timer.unref?.()
    this.pending.set(key, entry)
  }
}
const auditCoalescer = new AuditCoalescer()
/** Routine allowed-calls that must NOT echo into the fleet channel (denials of these still post). */
const ROUTINE_AUDIT_TOOLS = new Set(['chat_fetch', 'chat_send', 'task_get', 'task_watch', 'task_collect', 'task_list'])

export const name='agent-mesh-task-service'
export const inject=['agentMesh','credentials']
export interface Config { host?: string; port?: number; path?: string; healthPath?: string; serviceName?: string; registerWithSam?: boolean; shutdownTimeoutMs?: number; dbPath?: string; capabilityCredentialRef?: string; pairing?: boolean; pairControlPlane?: string; pairAnnouncePrivate?: boolean; memberCredentials?: boolean; membersPath?: string; memberScopes?: FleetScope[]; legacySharedCapability?: boolean; toolAllowlist?: string[]; inviteOnly?: boolean; peerExec?: boolean }
export const DEFAULT_TASK_DB = '~/.dsh/storages/agent-mesh-task-service/tasks.db'
export const Config:z<Config>=z.object({host:z.string().default('127.0.0.1'),port:z.natural().default(0),path:z.string().default('/mcp'),healthPath:z.string().default('/healthz'),serviceName:z.string().default('dsh-task-service'),registerWithSam:z.boolean().default(true),shutdownTimeoutMs:z.natural().default(5000),dbPath:z.string().default(DEFAULT_TASK_DB),capabilityCredentialRef:z.string().default(''),pairing:z.boolean().default(true),pairControlPlane:z.string().default('https://hub.sam-mesh.dev'),pairAnnouncePrivate:z.boolean().default(false),memberCredentials:z.boolean().default(true),membersPath:z.string().default(defaultMembersPath()),memberScopes:z.array(z.union(['tasks','inference','admin'])).default(['tasks','inference']),legacySharedCapability:z.boolean().default(true),toolAllowlist:z.array(z.string()).default([]),inviteOnly:z.boolean().default(false),peerExec:z.boolean().default(true)}) as unknown as z<Config>
declare module '@deepseek-ai/cordis' { interface Context { agentMeshTaskService: TaskService } }
export const provide=['agentMeshTaskService']
function resolveDbPath(value: string): string {
  if (value === ':memory:') return value
  const clean = value.trim()
  if (clean === '~') return homedir()
  if (clean.startsWith('~/')) return resolve(homedir(), clean.slice(2))
  return resolve(clean)
}
export async function apply(ctx:Context,config:Config):Promise<void>{
  const executor:TaskExecutor={async execute(task){return task.input ?? null}}
  // Tasks survive dsh restarts by default: SQLite (WAL) under the harness
  // home. ':memory:' opts back into ephemeral behavior (tests).
  const store = new SQLiteTaskStore(resolveDbPath(config.dbPath ?? DEFAULT_TASK_DB))
  // Capability gate (public-hub posture): when capabilityCredentialRef is
  // configured, mesh calls must present the fleet secret. A configured ref
  // that resolves to nothing fails CLOSED — an ephemeral per-boot secret no
  // caller can match — because 'announced but unprotected' is never the
  // intent of someone who set the ref.
  let capability: string | undefined
  const ref = config.capabilityCredentialRef?.trim() ?? ''
  if (ref) {
    const resolved = await ctx.credentials.resolve(credentialRef(ref)).catch(() => undefined)
    if (resolved?.value) capability = resolved.value
    else {
      capability = randomBytes(32).toString('hex')
      ctx.logger.warn(`capability ref '${ref}' is configured but empty — mesh calls to the task service will be REJECTED until the credential is provisioned (fail-closed)`)
    }
  }
  // Fleet pairing (public-hub onboarding): a machine that DISCOVERED this
  // service in the swarm can request the capability — approval seals the
  // invite to the requester's ephemeral key. Only meaningful with a gate:
  // an open service has no secret to deliver.
  const service=new TaskService(store,executor)
  // Per-member capabilities: pairing now MINTS a member capability (scopes
  // from memberScopes) instead of handing out the shared secret; the shared
  // capability stays valid as the OPERATOR credential while
  // legacySharedCapability holds (the migration posture). Revocation is
  // registry deletion — effective on the next gated call, here and at every
  // inference gate reading the same registry file.
  const members = config.memberCredentials === false ? undefined : new FleetMemberRegistry(config.membersPath ?? defaultMembersPath())
  if (config.pairing !== false && capability !== undefined) {
    withPairing(service, {
      // One-time invite codes: possession is the approval — a joiner with a
      // live code skips the operator round-trip entirely.
      invites: new InviteCodes(),
      ...(config.inviteOnly ? { inviteOnly: true } : {}),
      // The invite seals a MEMBER capability — the shared secret never
      // leaves this machine again. inviteFor may be async (the registry
      // write) and receives the requester's label for attribution. Invite
      // codes may carry narrower scopes; the default is the row's set.
      inviteFor: async (label: string, scopes?: string[]) => {
        const member = await members?.add(label || 'fleet-member', (scopes?.length ? scopes : config.memberScopes ?? ['tasks','inference']) as FleetScope[], 'paired')
        return JSON.stringify({
          version: 1, controlPlane: config.pairControlPlane ?? 'https://hub.sam-mesh.dev',
          serviceName: config.serviceName ?? 'dsh-task-service',
          capability: member?.capability ?? capability ?? '',
          ...(member ? { memberId: member.id, memberName: member.name, scopes: member.scopes } : {}),
          announcePrivate: config.pairAnnouncePrivate ?? false, createdAt: new Date().toISOString(),
        })
      },
    })
  }
  if (members) withMemberTools(service, members)
  // Operator remote execution (peer_exec): the caller must present THIS
  // machine's fleet capability — in practice the member itself or the
  // operator holding the registry. Audited like every other gated call.
  if (config.peerExec !== false) for (const tool of peerExecTools()) service.tools.register(tool)
  // Authorization chain: member identification + scopes first, then the
  // fleet-facing tool allowlist. With no members configured this is exactly
  // the legacy posture (shared capability everywhere).
  const authorizers: Authorizer[] = []
  if (members) authorizers.push(new MemberAuthorizer(
    async () => (await members.list()).map(m => ({ capability: m.capability, name: m.name, scopes: m.scopes })),
    config.legacySharedCapability === false ? undefined : capability,
  ))
  else if (capability !== undefined) authorizers.push(new CapabilityAuthorizer(capability))
  if (config.toolAllowlist?.length) authorizers.push(new ToolAllowlistAuthorizer(config.toolAllowlist))
  const server=new TaskHttpServer(service,{
    ...config,
    ...(capability!==undefined?{capability}:{}),
    ...(authorizers.length?{authorizers}:{}),
    onAudit: event => {
      console.info(`[agent-mesh-task-service] [fleet-audit] ${event.tool} ${event.allowed ? 'allowed' : 'DENIED'}${event.member ? ` member=${event.member}` : ''}`)
      // Optional chat bridge: the dsh-mesh-chat plugin (if installed) turns
      // fleet audit events into system messages in the fleet channel.
      // Structural — this plugin never imports the chat package. Identical
      // events coalesce over a 2s window ('…×47 in 2s'): a busy gate must
      // not drown the conversation.
      const chat = (ctx as Context & { get?(name: string): unknown }).get?.('agentMeshChat') as { postSystem?(text: string, meta?: unknown): void } | undefined
      if (chat?.postSystem) {
        // Feed-worthy events only: routine reads/echoes (chat_fetch/send,
        // task polling) are noise — the channel is for MEANINGFUL fleet
        // activity (pairing, members, exec, steering) and every denial.
        if (event.allowed && ROUTINE_AUDIT_TOOLS.has(event.tool)) return
        const key = `${event.tool}|${event.allowed}|${event.member ?? ''}`
        auditCoalescer.add(key, (count) => {
          const base = `${event.tool} ${event.allowed ? 'allowed' : 'DENIED'}${event.member ? ` — ${event.member}` : ''}`
          chat.postSystem!(count > 1 ? `${base} (×${count} in 2s)` : base, { tool: event.tool, allowed: event.allowed, ...(event.member ? { member: event.member } : {}), ...(count > 1 ? { count } : {}) })
        })
      }
    },
  }); const address=await server.start(); ctx.provide('agentMeshTaskService',service)
  let registration:Awaited<ReturnType<Client['register']>>|undefined
  let stopReannounce:(()=>void)|undefined
  const PLUGIN_VERSION='0.1.0'
  const registry=new SamTaskRegistrationClient((ctx as Context & {agentMesh:AgentMeshService}).agentMesh.core)
  let retryTimer:ReturnType<typeof setInterval>|undefined
  if(config.registerWithSam!==false){
    // Registration must never fail the boot: the node may be auto-starting
    // concurrently (plugin row ordering is not a readiness contract), or simply
    // absent. Attempt inline, then retry on a slow bounded loop; the service
    // stays local-only until a retry lands.
    // B2: never shadow the fleet's name — a CONSUMER replica renames itself
    // at boot when the configured name is already announced remotely. The
    // OPERATOR never renames: it holds the fleet's shared capability (the
    // pairing gate), which is the ownership claim on the name. (First version
    // renamed escha itself because discovery timing is racy at boot.)
    let effectiveName=config.serviceName ?? 'dsh-task-service'
    const isOperator=capability!==undefined
    if(!isOperator){
      try {
        const remotes=await (ctx as Context & {agentMesh:AgentMeshService}).agentMesh.core.discoverRemoteServices({type:'mcp',name:effectiveName})
        const reconciled=reconcileServiceName(effectiveName,remotes.map(s=>s.srv_name).filter((n): n is string => typeof n === 'string'))
        if(reconciled.renamed){ effectiveName=reconciled.name; console.info(`[agent-mesh-task-service] '${config.serviceName}' is already announced by the fleet — registering as '${effectiveName}' (consumer replica)`) }
      } catch { /* discovery down at boot — keep the configured name */ }
    }
    const startReannounce=():void=>{
      if(stopReannounce) return
      const name=effectiveName
      void import('@morewax/sam-mesh/node').then(({ startServiceAnnounceLoop })=>{
        stopReannounce=startServiceAnnounceLoop({
          name, type:'SERVICE_TYPE_MCP', targetUrl:address.mcpUrl, description:`dsh fleet task service (dsh-agent-mesh ${PLUGIN_VERSION})`,
          register: async body => { const res=await (ctx as Context & {agentMesh:AgentMeshService}).agentMesh.core.requestRaw('/sam/service/register',{method:'POST',body}); if(res.status<200||res.status>=300) throw new Error(`re-register failed (${res.status})`) },
          intervalMs: 30_000,
          onLog: line => console.info(`[agent-mesh-task-service] ${line}`),
        })
      })
    }
    const attempt=async():Promise<boolean>=>{
      try{ registration=await registry.register(address,{name:effectiveName,description:`dsh fleet task service (dsh-agent-mesh ${PLUGIN_VERSION})`}); startReannounce(); return true }
      catch(error){ ctx.logger.warn(`task service SAM registration failed (will retry): ${error instanceof Error?error.message:String(error)}`); return false }
    }
    if(!await attempt()){
      let attempts=0
      retryTimer=setInterval(()=>{attempts+=1;void attempt().then(ok=>{if(ok){ctx.logger.info('task service registered with SAM after retry');clearInterval(retryTimer)}else if(attempts>=40){ctx.logger.warn('task service SAM registration gave up after 40 attempts; service stays local-only');clearInterval(retryTimer)}})},5_000)
      retryTimer.unref?.()
    }
  }
  ctx.effect(()=>async()=>{if(retryTimer)clearInterval(retryTimer);if(stopReannounce)stopReannounce();if(registration) await registry.unregister(registration).catch(error=>ctx.logger.warn(`task service unregister failed: ${error instanceof Error?error.message:String(error)}`));await server.stop();store.close()},'agent-mesh-task-service.lifecycle')
}
