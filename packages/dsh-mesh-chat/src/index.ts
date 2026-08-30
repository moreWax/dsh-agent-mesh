/**
 * @morewax/dsh-mesh-chat — authenticated chat over the SAM mesh.
 *
 * Three surfaces, one store:
 * - Fleet channel: tools on the fleet server's task service (member-gated),
 *   consumed remotely by every member; system events land here too.
 * - DM inbox: a rate-limited MCP edge this node announces; peers send DMs as
 *   authenticated tool calls.
 * - The card: chatSnapshot/chatSend/dmSend remotes (web host + client).
 *
 * Consumes the `agentMesh` service structurally; NEVER imports
 * @morewax/dsh-agent-mesh (plugin-to-plugin imports are a trust-boundary
 * violation — services are the only seam).
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SamServiceRegistrationClient, packageVersionOf, type AgentMeshFace } from '@morewax/sam-mesh'
import { SQLiteChatStore } from './store.js'
import { createInboxServer } from './inbox.js'
import { registerFleetChatTools, type ToolMountService } from './fleet-channel.js'
import { FleetPublisher, FleetSubscriber, chatTopic } from './notifier.js'
import { startHealthBeacon, healthOf, healthTopic, type HealthState } from './health.js'
import { MeshChatWebHost } from './web/host.js'

export const name = 'agent-mesh-chat'
const CHAT_VERSION = await packageVersionOf(new URL('../package.json', import.meta.url))
export const inject = ['agentMesh', 'credentials']

export interface Config {
  dbPath?: string
  inbox?: { host?: string; port?: number; serviceName?: string; registerWithSam?: boolean }
  fleetChannel?: { enabled?: boolean; serviceName?: string }
  systemEvents?: boolean
  maxMessageChars?: number
  inboxCap?: number
  rateLimitPerMinute?: number
  notifications?: boolean
  membersPath?: string
}
export const Config: z<Config> = z.object({
  dbPath: z.string().default('~/.dsh/storages/agent-mesh-chat/chat.db'),
  inbox: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.natural().default(0),
    serviceName: z.string().default('dsh-chat-inbox'),
    registerWithSam: z.boolean().default(true),
  }),
  fleetChannel: z.object({
    enabled: z.boolean().default(true),
    serviceName: z.string().default('dsh-task-service'),
  }),
  systemEvents: z.boolean().default(true),
  maxMessageChars: z.natural().default(4000),
  inboxCap: z.natural().default(500),
  rateLimitPerMinute: z.natural().default(10),
  notifications: z.boolean().default(true),
  membersPath: z.string().default(`${process.env.HOME}/.config/sam-mesh/fleet-members.json`),
}) as unknown as z<Config>

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const dbPath = (config.dbPath ?? '~/.dsh/storages/agent-mesh-chat/chat.db').replace(/^~(?=\/)/, homedir())
  const store = new SQLiteChatStore(dbPath)

  // 1. DM inbox: bind loopback, announce to the mesh.
  const inboxServer = createInboxServer(store, config)
  const host = config.inbox?.host ?? '127.0.0.1'
  const port = config.inbox?.port ?? 0
  const inboxName = config.inbox?.serviceName ?? 'dsh-chat-inbox'
  let registration: Awaited<ReturnType<SamServiceRegistrationClient['register']>> | undefined
  let stopHealthBeacon: (() => void) | undefined
  let stopInboxReannounce: (() => void) | undefined
  const registerInbox = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => { inboxServer.once('error', reject); inboxServer.listen(port, host, () => resolve()) })
    if (config.inbox?.registerWithSam !== false) {
      const client = new SamServiceRegistrationClient((ctx as unknown as { agentMesh: AgentMeshFace }).agentMesh.core as unknown as import('@morewax/sam-mesh').SamRegistrationTransport)
      const address = inboxServer.address()
      const mcpUrl = `http://${host}:${typeof address === 'object' && address ? address.port : port}/mcp`
      registration = await client.register(mcpUrl, { name: inboxName, description: `dsh-mesh-chat DM inbox (dsh-mesh-chat ${CHAT_VERSION})` })
        .catch(error => { ctx.logger.warn(`chat inbox registration failed (will run local-only): ${error instanceof Error ? error.message : String(error)}`); return undefined })
      if (registration) {
        const { startServiceAnnounceLoop } = await import('@morewax/sam-mesh/node')
        stopInboxReannounce = startServiceAnnounceLoop({
          name: inboxName, type: 'SERVICE_TYPE_MCP', targetUrl: mcpUrl,
          description: `dsh-mesh-chat DM inbox (dsh-mesh-chat ${CHAT_VERSION})`,
          register: async body => {
            const res = await (ctx as unknown as { agentMesh: { core: { requestRaw(path: string, options: { method: string; body?: unknown }): Promise<{ status: number }> } } }).agentMesh.core.requestRaw('/sam/service/register', { method: 'POST', body })
            if (res.status < 200 || res.status >= 300) throw new Error(`re-register failed (${res.status})`)
          },
          intervalMs: 30_000,
        })
      }
    }
  }
  void registerInbox()

  // 2. Fleet channel: when THIS machine hosts the task service, mount chat
  // tools on its registry (they ride its endpoint + authorizer chain).
  // The publisher fans every appended message out to members over GossipSub.
  const fleetName = config.fleetChannel?.serviceName ?? 'dsh-task-service'
  const meshCore = (ctx as unknown as { agentMesh: AgentMeshFace }).agentMesh.core
  // Resolve against discovery: operator-chosen prefixes mean the configured
  // name may only be a SUFFIX of the swarm name.
  const discovered = await meshCore.callTool<Array<{ srv_name?: string }>>('discover_remote_services', { type: 'mcp' }).catch(() => [])
  const resolvedFleet = discovered.some(s => s.srv_name === fleetName)
    ? fleetName
    : discovered.find(s => typeof s.srv_name === 'string' && s.srv_name.endsWith('task-service'))?.srv_name ?? fleetName
  const emitUpdated = (): void => {
    // Push, not poll: the card subscribes to this host event (same pattern as
    // llm/adapters-updated) and refetches on arrival.
    try { for (const listener of (ctx as unknown as { events?: { dispatch?(mode: string, args: unknown[]): unknown } }).events?.dispatch?.('emit', ['mesh-chat/updated']) as Array<() => unknown> | undefined ?? []) listener() } catch { /* non-fatal */ }
  }
  const operatorCap = await ((ctx as unknown as { agentMesh: AgentMeshFace }).agentMesh.resolveCallCapability?.().catch(() => undefined) ?? Promise.resolve(undefined))
  const publisher = config.notifications === false
    ? undefined
    : new FleetPublisher(meshCore, {
      serviceName: resolvedFleet,
      membersPath: (config.membersPath ?? `${homedir()}/.config/sam-mesh/fleet-members.json`).replace(/^~(?=\/)/, homedir()),
      operatorCapability: operatorCap,
      log: line => console.info(`[mesh-chat] ${line}`),
    })
  const notifyAppend = publisher ? (message: { id: number; kind: string; sender: string; text: string; ts: number; meta?: unknown }): void => { void publisher.publish(message as never); emitUpdated() } : undefined
  if (config.fleetChannel?.enabled !== false) {
    ctx.inject(['agentMeshTaskService'], (taskCtx) => {
      const service = (taskCtx as unknown as { agentMeshTaskService: ToolMountService }).agentMeshTaskService
      registerFleetChatTools(service, store, { ...(config.maxMessageChars !== undefined ? { maxMessageChars: config.maxMessageChars } : {}), ...(notifyAppend ? { onAppend: notifyAppend } : {}) })
      localFleet = {
        fetch: (afterId, limit) => store.fetch('fleet', afterId, limit),
        send: text => { const message = store.append('fleet', { kind: 'user', sender: 'operator', text }); notifyAppend?.(message) },
      }
      // The operator-as-emitter: this machine hosts the fleet, so it probes
      // hub trust in ONE place and broadcasts signed health to every member.
      if (publisher) {
        stopHealthBeacon = startHealthBeacon({
          serviceName: resolvedFleet,
          publisher,
          bus: meshCore,
          onTransition: (healthy, rejectionCount) => {
            const note = healthy ? 'hub trust recovered — mesh signatures verify again' : `hub trust degraded — ${rejectionCount} peers reject our identity (rotation missed or hub inconsistent)`
            const message = store.append('fleet', { kind: 'system', sender: 'system', text: note })
            notifyAppend?.(message)
          },
          log: line => console.info(`[mesh-chat] ${line}`),
        })
      }
    })
  }

  // 3. System events: the task service's audit stream posts into the fleet
  //    channel. We provide the poster; the tasks plugin consumes it optionally.
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentMeshChat', {
    postSystem: (text: string, meta?: unknown): void => {
      if (config.systemEvents === false) return
      try {
        const message = store.append('fleet', { kind: 'system', sender: 'system', text, ...(meta !== undefined ? { meta } : {}) })
        notifyAppend?.(message)
      } catch { /* never crash the auditor */ }
    },
  })

  // 5. Subscriber: consume the fleet's GossipSub feed (when this machine
  // holds a capability) — arrival pushes a host event; the card refetches.
  let healthState: HealthState | undefined
  let subscriber: FleetSubscriber | undefined
  if (config.notifications !== false) {
    const resolveCapability = (ctx as unknown as { agentMesh: AgentMeshFace }).agentMesh.resolveCallCapability
    void (async () => {
      const capability = await resolveCapability?.().catch(() => undefined)
      if (!capability) return // consumer without a fleet: nothing to open
      subscriber = new FleetSubscriber(meshCore, {
        serviceName: resolvedFleet,
        capability,
        log: line => console.info(`[mesh-chat] ${line}`),
        onMessage: message => {
          const health = healthOf(message as unknown as { channel?: string; sender?: string; text?: string })
          if (health) healthState = { hubConsistent: health.hubConsistent, rejectionCount: health.rejectionCount, ts: health.ts }
          emitUpdated()
        },
      })
      await subscriber.start([healthTopic(resolvedFleet)]).catch(error => ctx.logger.warn(`[mesh-chat] subscribe failed: ${error instanceof Error ? error.message : String(error)}`))
    })()
  }

  // 4. The web host (card remotes). Same process, structural seam only.
  // localFleet is set when the task-service injection mounts our tools here —
  // the fleet server reads/writes its own store, never its own RPC.
  let localFleet: { fetch(afterId: number, limit: number): unknown[]; send(text: string): void } | undefined
  new MeshChatWebHost(ctx, {
    get localFleet() { return localFleet },
    get health() { return healthState },
    store,
    ...(config.inbox?.serviceName ? { inboxServiceName: config.inbox.serviceName } : {}),
    ...(config.fleetChannel?.serviceName ? { fleetServiceName: config.fleetChannel.serviceName } : {}),
    ...(config.maxMessageChars ? { maxMessageChars: config.maxMessageChars } : {}),
  })

  ctx.effect(() => () => {
    subscriber?.stop()
    if (stopHealthBeacon) stopHealthBeacon()
    if (stopInboxReannounce) stopInboxReannounce()
    if (registration) void new SamServiceRegistrationClient((ctx as unknown as { agentMesh: AgentMeshFace }).agentMesh.core as unknown as import('@morewax/sam-mesh').SamRegistrationTransport).unregister(registration).catch(() => undefined)
    inboxServer.close()
    store.close()
  })
}
