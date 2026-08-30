/**
 * @morewax/dsh-imessage — iMessage for the fleet.
 *
 * Three surfaces, one plugin (the dsh-mesh-chat pattern):
 * - dsh agent tools: send/read/search iMessage from this Mac's agent
 * - a fleet service: the same tools mounted on the task service,
 *   capability-gated — any fleet member's agent can use this Apple ID
 * - inbound as mesh events: new messages from allowlisted handles land in
 *   the fleet channel as system events (sealed notification fan-out)
 *
 * macOS only. Two one-time TCC permissions gate reality, and the plugin
 * reports them honestly instead of crashing: Full Disk Access (chat.db
 * reads) and Automation (Messages.app sends). macOS pops the prompts; the
 * fix text names the exact System Settings pane.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonFileView, toolPayload, type AgentMeshFace, type TaskServiceToolMount } from '@morewax/sam-mesh'
import { openMessagesDb, currentWatermark, fetchSince, fetchHistory, searchMessages, chatParticipants, type IMessage } from './db.js'
import { sendIMessage } from './sender.js'
import { defaultAccess, isAllowed, type AccessFile } from './access.js'
import type { DatabaseSync } from 'node:sqlite'

export const name = 'dsh-imessage'
export const inject = ['agentMesh', 'credentials']

export interface Config {
  dbPath?: string
  stateDir?: string
  allowSms?: boolean
  /** Inbound watch interval ms (default 2000; 0 disables inbound delivery). */
  watchMs?: number
  /** Outbound signature line appended to fleet-sent messages ('' disables). */
  signature?: string
  /** Own handles (for self-chat detection); empty = treat 1:1 chats as self-chat only when they have no other participant. */
  ownHandles?: string[]
  /** Fleet mount: also expose the tools on the mesh task service (default true). */
  fleetTools?: boolean
}
export const Config: z<Config> = z.object({
  dbPath: z.string().default('~/Library/Messages/chat.db'),
  stateDir: z.string().default('~/.config/dsh-imessage'),
  allowSms: z.boolean().default(false),
  watchMs: z.natural().default(2000),
  signature: z.string().default('\nSent via the mesh'),
  ownHandles: z.array(z.string()).default([]),
  fleetTools: z.boolean().default(true),
}) as unknown as z<Config>

const FDA_FIX = 'Full Disk Access missing — System Settings → Privacy & Security → Full Disk Access → allow your terminal (or the dsh host app)'

export function apply(ctx: Context, config: Config = {}): void {
  const dbPath = (config.dbPath ?? '~/Library/Messages/chat.db').replace(/^~(?=\/)/, homedir())
  const stateDir = (config.stateDir ?? '~/.config/dsh-imessage').replace(/^~(?=\/)/, homedir())
  const allowSms = config.allowSms === true
  const ownHandles = (config.ownHandles ?? []).map(h => h.trim().toLowerCase())
  const access = new JsonFileView<AccessFile>(join(stateDir, 'access.json'), raw => JSON.parse(raw) as AccessFile, defaultAccess(), async p => (await import('node:fs/promises')).stat(p))

  let db: DatabaseSync | undefined
  let dbError: string | undefined
  const openDb = (): DatabaseSync => {
    if (db) return db
    try {
      db = openMessagesDb(dbPath)
      return db
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error)
      throw new Error(/authorization denied|not authorized|EPERM|EACCES/i.test(dbError) ? FDA_FIX : `cannot open Messages database: ${dbError}`)
    }
  }

  const withParticipants = (messages: IMessage[]): IMessage[] => {
    if (messages.length === 0) return messages
    const map = chatParticipants(openDb(), [...new Set(messages.map(m => m.chatId))])
    for (const m of messages) m.participants = map.get(m.chatId) ?? []
    return messages
  }

  // ── dsh agent tools (registered on the local task service when present) ──
  const tools = [
    { name: 'imessage_send', description: 'Send an iMessage to a chat (chat_guid) from this Mac. Capability-gated.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', required: ['chat_guid', 'text'], properties: { chat_guid: { type: 'string' }, text: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      handler: async (args: { chat_guid?: unknown; text?: unknown; files?: unknown }) => {
        const chatGuid = typeof args.chat_guid === 'string' ? args.chat_guid : ''
        const text = typeof args.text === 'string' ? args.text : ''
        if (!chatGuid || !text.trim()) throw new Error('chat_guid and text are required')
        const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : []
        const signature = config.signature ?? ''
        return await sendIMessage(chatGuid, text + signature, files)
      } },
    { name: 'imessage_read', description: 'Recent iMessage history as threads (all allowlisted chats, or one chat_guid). Oldest-first per chat.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', properties: { chat_guid: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      handler: async (args: { chat_guid?: unknown; limit?: unknown }) => {
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 100
        const messages = withParticipants(fetchHistory(openDb(), { ...(typeof args.chat_guid === 'string' ? { chatGuid: args.chat_guid } : {}), limit, allowSms }))
        const ac = await access.get()
        return { messages: messages.filter(m => isAllowed(m, ac, ownHandles)) }
      } },
    { name: 'imessage_search', description: 'Full-text search across iMessage history.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      handler: async (args: { query?: unknown; limit?: unknown }) => {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) throw new Error('query is required')
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 25
        const messages = withParticipants(searchMessages(openDb(), query, limit, allowSms))
        const ac = await access.get()
        return { messages: messages.filter(m => isAllowed(m, ac, ownHandles)) }
      } },
    { name: 'imessage_access', description: 'Show or update the iMessage allowlist (operator). action: list|allow|deny, handle: +1555… or email',
      auth: 'operator' as const,
      schema: { type: 'object', required: ['action'], properties: { action: { type: 'string' }, handle: { type: 'string' } }, additionalProperties: false },
      handler: async (args: { action?: unknown; handle?: unknown }) => {
        const action = typeof args.action === 'string' ? args.action : 'list'
        const { writeFile, mkdir } = await import('node:fs/promises')
        const path = join(stateDir, 'access.json')
        const current = await access.get()
        if (action === 'list') return { allow: current.allow, ownHandles }
        const handle = typeof args.handle === 'string' ? args.handle.trim() : ''
        if (!handle) throw new Error('handle is required for allow/deny')
        const next = action === 'allow'
          ? { allow: [...new Set([...current.allow, handle])] }
          : { allow: current.allow.filter(h => h !== handle) }
        await mkdir(stateDir, { recursive: true })
        await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
        return { allow: next.allow }
      } },
  ]

  if (config.fleetTools !== false) {
    ctx.inject(['agentMeshTaskService'], (taskCtx) => {
      const service = (taskCtx as unknown as { agentMeshTaskService: TaskServiceToolMount }).agentMeshTaskService
      for (const tool of tools) service.tools.register(tool)
    })
  }

  // ── inbound watcher: poll chat.db, deliver allowlisted new messages as
  // fleet-channel system events through the chat plugin's poster. ──
  let timer: ReturnType<typeof setInterval> | undefined
  if ((config.watchMs ?? 2000) > 0) {
    let watermark = -1 // -1 = initialize to MAX(ROWID) on first tick (no replay)
    timer = setInterval(() => void (async () => {
      try {
        const database = openDb()
        if (watermark < 0) { watermark = currentWatermark(database); return }
        const fresh = fetchSince(database, watermark, allowSms)
        if (fresh.length === 0) return
        watermark = fresh[fresh.length - 1]!.rowid
        const ac = await access.get()
        const allowed = withParticipants(fresh).filter(m => isAllowed(m, ac, ownHandles))
        if (allowed.length === 0) return
        const chat = (ctx as unknown as { get?(name: string): unknown }).get?.('agentMeshChat') as { postSystem?(text: string, meta?: unknown): void } | undefined
        for (const m of allowed) {
          const label = m.chatTitle ?? m.sender
          chat?.postSystem?.(`📱 ${label}: ${m.text ?? (m.attachmentPath ? '[attachment]' : '[no text]')}`, { from: 'imessage', sender: m.sender, chatGuid: m.chatGuid, rowid: m.rowid })
        }
      } catch { /* FDA not granted yet or db busy — next tick retries */ }
    })(), config.watchMs ?? 2000)
    timer.unref?.()
  }

  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
    db?.close()
  })
}
