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
import { SamServiceRegistrationClient } from '@morewax/sam-mesh'
import { SQLiteChatStore } from './store.js'
import { createInboxServer } from './inbox.js'
import { registerFleetChatTools, type ToolMountService } from './fleet-channel.js'
import { MeshChatWebHost } from './web/host.js'

export const name = 'agent-mesh-chat'
export const inject = ['agentMesh', 'credentials']

export interface Config {
  dbPath?: string
  inbox?: { host?: string; port?: number; serviceName?: string; registerWithSam?: boolean }
  fleetChannel?: { enabled?: boolean; serviceName?: string }
  systemEvents?: boolean
  maxMessageChars?: number
  inboxCap?: number
  rateLimitPerMinute?: number
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
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config = {}): void {
  const dbPath = (config.dbPath ?? '~/.dsh/storages/agent-mesh-chat/chat.db').replace(/^~(?=\/)/, homedir())
  const store = new SQLiteChatStore(dbPath)

  // 1. DM inbox: bind loopback, announce to the mesh.
  const inboxServer = createInboxServer(store, config)
  const host = config.inbox?.host ?? '127.0.0.1'
  const port = config.inbox?.port ?? 0
  const inboxName = config.inbox?.serviceName ?? 'dsh-chat-inbox'
  let registration: Awaited<ReturnType<SamServiceRegistrationClient['register']>> | undefined
  const registerInbox = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => { inboxServer.once('error', reject); inboxServer.listen(port, host, () => resolve()) })
    if (config.inbox?.registerWithSam !== false) {
      const client = new SamServiceRegistrationClient((ctx as unknown as { agentMesh: { core: import('@morewax/sam-mesh').SamRegistrationTransport } }).agentMesh.core)
      const address = inboxServer.address()
      registration = await client.register(`http://${host}:${typeof address === 'object' && address ? address.port : port}/mcp`, { name: inboxName, description: 'dsh-mesh-chat DM inbox' })
        .catch(error => { ctx.logger.warn(`chat inbox registration failed (will run local-only): ${error instanceof Error ? error.message : String(error)}`); return undefined })
    }
  }
  void registerInbox()

  // 2. Fleet channel: when THIS machine hosts the task service, mount chat
  // tools on its registry (they ride its endpoint + authorizer chain).
  if (config.fleetChannel?.enabled !== false) {
    ctx.inject(['agentMeshTaskService'], (taskCtx) => {
      const service = (taskCtx as unknown as { agentMeshTaskService: ToolMountService }).agentMeshTaskService
      registerFleetChatTools(service, store, config.maxMessageChars !== undefined ? { maxMessageChars: config.maxMessageChars } : {})
    })
  }

  // 3. System events: the task service's audit stream posts into the fleet
  //    channel. We provide the poster; the tasks plugin consumes it optionally.
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentMeshChat', {
    postSystem: (text: string, meta?: unknown): void => {
      if (config.systemEvents === false) return
      try { store.append('fleet', { kind: 'system', sender: 'system', text, ...(meta !== undefined ? { meta } : {}) }) } catch { /* never crash the auditor */ }
    },
  })

  // 4. The web host (card remotes). Same process, structural seam only.
  new MeshChatWebHost(ctx, {
    store,
    ...(config.inbox?.serviceName ? { inboxServiceName: config.inbox.serviceName } : {}),
    ...(config.fleetChannel?.serviceName ? { fleetServiceName: config.fleetChannel.serviceName } : {}),
    ...(config.maxMessageChars ? { maxMessageChars: config.maxMessageChars } : {}),
  })

  ctx.effect(() => () => {
    if (registration) void new SamServiceRegistrationClient((ctx as unknown as { agentMesh: { core: import('@morewax/sam-mesh').SamRegistrationTransport } }).agentMesh.core).unregister(registration).catch(() => undefined)
    inboxServer.close()
    store.close()
  })
}
