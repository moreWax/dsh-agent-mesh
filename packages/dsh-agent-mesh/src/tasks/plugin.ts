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
import { TaskHttpServer } from './http.js'
import { CapabilityAuthorizer } from './authz.js'
import { SamTaskRegistrationClient } from './registration.js'
export const name='agent-mesh-task-service'
export const inject=['agentMesh','credentials']
export interface Config { host?: string; port?: number; path?: string; healthPath?: string; serviceName?: string; registerWithSam?: boolean; shutdownTimeoutMs?: number; dbPath?: string; capabilityCredentialRef?: string; pairing?: boolean; pairControlPlane?: string; pairAnnouncePrivate?: boolean; memberCredentials?: boolean; membersPath?: string; memberScopes?: FleetScope[]; legacySharedCapability?: boolean; toolAllowlist?: string[] }
export const DEFAULT_TASK_DB = '~/.dsh/storages/agent-mesh-task-service/tasks.db'
export const Config:z<Config>=z.object({host:z.string().default('127.0.0.1'),port:z.natural().default(0),path:z.string().default('/mcp'),healthPath:z.string().default('/healthz'),serviceName:z.string().default('dsh-task-service'),registerWithSam:z.boolean().default(true),shutdownTimeoutMs:z.natural().default(5000),dbPath:z.string().default(DEFAULT_TASK_DB),capabilityCredentialRef:z.string().default(''),pairing:z.boolean().default(true),pairControlPlane:z.string().default('https://hub.sam-mesh.dev'),pairAnnouncePrivate:z.boolean().default(false),memberCredentials:z.boolean().default(true),membersPath:z.string().default(defaultMembersPath()),memberScopes:z.array(z.union(['tasks','inference','admin'])).default(['tasks','inference']),legacySharedCapability:z.boolean().default(true),toolAllowlist:z.array(z.string()).default([])}) as unknown as z<Config>
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
    onAudit: event => console.info(`[agent-mesh-task-service] [fleet-audit] ${event.tool} ${event.allowed ? 'allowed' : 'DENIED'}${event.member ? ` member=${event.member}` : ''}`),
  }); const address=await server.start(); ctx.provide('agentMeshTaskService',service)
  let registration:Awaited<ReturnType<SamTaskRegistrationClient['register']>>|undefined
  const registry=new SamTaskRegistrationClient((ctx as Context & {agentMesh:AgentMeshService}).agentMesh.core)
  let retryTimer:ReturnType<typeof setInterval>|undefined
  if(config.registerWithSam!==false){
    // Registration must never fail the boot: the node may be auto-starting
    // concurrently (plugin row ordering is not a readiness contract), or simply
    // absent. Attempt inline, then retry on a slow bounded loop; the service
    // stays local-only until a retry lands.
    const attempt=async():Promise<boolean>=>{
      try{ registration=await registry.register(address,config.serviceName === undefined ? {} : {name:config.serviceName}); return true }
      catch(error){ ctx.logger.warn(`task service SAM registration failed (will retry): ${error instanceof Error?error.message:String(error)}`); return false }
    }
    if(!await attempt()){
      let attempts=0
      retryTimer=setInterval(()=>{attempts+=1;void attempt().then(ok=>{if(ok){ctx.logger.info('task service registered with SAM after retry');clearInterval(retryTimer)}else if(attempts>=40){ctx.logger.warn('task service SAM registration gave up after 40 attempts; service stays local-only');clearInterval(retryTimer)}})},5_000)
      retryTimer.unref?.()
    }
  }
  ctx.effect(()=>async()=>{if(retryTimer)clearInterval(retryTimer);if(registration) await registry.unregister(registration).catch(error=>ctx.logger.warn(`task service unregister failed: ${error instanceof Error?error.message:String(error)}`));await server.stop();store.close()},'agent-mesh-task-service.lifecycle')
}
