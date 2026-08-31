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
 * Backends are platform-isolated: macOS uses read-only chat.db + Messages,
 * while Linux uses the explicitly configured Matrix/corten bridge. Plugin
 * boot never installs or deploys infrastructure. Backend status and errors
 * name the exact setup or permission action without exposing credentials.
 */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { JsonFileView, toolPayload, type AgentMeshFace, type TaskServiceToolMount } from '@morewax/sam-mesh'
import { keyTools } from './key-tools.js'
import { createBackend, selectBackend, type BackendChoice } from './backends/select.js'
import type { IMessageBackend } from './backends/interface.js'
import { NativeBackend } from './backends/native.js'
import { defaultAccess, isAllowed, type AccessFile } from './access.js'

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
  /** auto = native on macOS, Matrix/corten-matrix on Linux. */
  backend?: BackendChoice
  matrix?: { homeserverUrl?: string; accessTokenRef?: string; roomId?: string }
}
export const Config: z<Config> = z.object({
  dbPath: z.string().default('~/Library/Messages/chat.db'),
  stateDir: z.string().default('~/.config/dsh-imessage'),
  allowSms: z.boolean().default(false),
  watchMs: z.natural().default(2000),
  signature: z.string().default('\nSent via the mesh'),
  ownHandles: z.array(z.string()).default([]),
  fleetTools: z.boolean().default(true),
  backend: z.union(['auto', 'native', 'matrix']).default('auto'),
  matrix: z.object({ homeserverUrl: z.string(), accessTokenRef: z.string(), roomId: z.string() }),
}) as unknown as z<Config>

const FDA_FIX = 'Full Disk Access missing — System Settings → Privacy & Security → Full Disk Access → allow your terminal (or the dsh host app)'

function validateHardwareKey(stateDir: string): boolean {
  if (process.platform !== 'linux') return true
  return existsSync(join(stateDir, 'hardware-key.bin'))
}

export function apply(ctx: Context, config: Config = {}): void {
  const dbPath = (config.dbPath ?? '~/Library/Messages/chat.db').replace(/^~(?=\/)/, homedir())
  const stateDir = (config.stateDir ?? '~/.config/dsh-imessage').replace(/^~(?=\/)/, homedir())

  // Linux setup is explicit and resumable — never install k3s or launch
  // workloads merely because a dsh profile booted. The UI/tools call the
  // setup action after the user chooses an existing cluster or private
  // rootless k3s. This keeps plugin installation side-effect-free.
  const allowSms = config.allowSms === true
  const ownHandles = (config.ownHandles ?? []).map(h => h.trim().toLowerCase())
  const access = new JsonFileView<AccessFile>(join(stateDir, 'access.json'), raw => JSON.parse(raw) as AccessFile, defaultAccess(), async p => (await import('node:fs/promises')).stat(p))

  const selectedBackend = selectBackend(config.backend ?? 'auto')
  let backend: IMessageBackend | undefined
  let backendError: string | undefined
  if (selectedBackend === 'native') {
    try { backend = createBackend({ choice: 'native', native: { dbPath, allowSms } }); void backend.start().catch(error => { backendError = error instanceof Error ? error.message : String(error) }) }
    catch (error) { backendError = error instanceof Error ? error.message : String(error) }
  } else if (selectedBackend === 'matrix') {
    // Matrix access tokens are references, never values in the profile config.
    // The credential resolver is async; backend construction happens after the
    // task-service injection below, where the same resolver is available.
    const matrix = config.matrix
    if (matrix?.homeserverUrl && matrix.accessTokenRef && matrix.roomId) {
      void (ctx as Context & { credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> } }).credentials.resolve(credentialRef(matrix.accessTokenRef)).then(async (resolved: { value?: string } | undefined) => {
        if (resolved?.value) { backend = createBackend({ choice: 'matrix', matrix: { homeserverUrl: matrix.homeserverUrl!, accessToken: resolved.value, roomId: matrix.roomId! } }); await backend.start() }
        else backendError = 'Matrix access token is not provisioned — store it through dsh credentials'
      }).catch((error: unknown) => { backendError = error instanceof Error ? error.message : String(error) })
    } else backendError = 'Linux iMessage backend needs Matrix homeserver URL, access-token reference, and room ID'
  } else backendError = `iMessage is unsupported on this platform (${process.platform})`

  const requireBackend = (): IMessageBackend => backend ?? (() => { throw new Error(backendError ?? 'iMessage backend is still starting') })()

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
        return await requireBackend().send({ conversationId: chatGuid, text: text + signature, files })
      } },
    { name: 'imessage_read', description: 'Recent iMessage history as threads (all allowlisted chats, or one chat_guid). Oldest-first per chat.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', properties: { chat_guid: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      handler: async (args: { chat_guid?: unknown; limit?: unknown }) => {
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 100
        const messages = await requireBackend().read({ ...(typeof args.chat_guid === 'string' ? { conversationId: args.chat_guid } : {}), limit })
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
        const messages = await requireBackend().search({ query, limit })
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
    { name: 'imessage_status', description: 'Show the selected iMessage backend and setup state.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => backend ? await backend.status() : ({ kind: selectedBackend, state: process.platform === 'linux' ? 'needs_setup' : 'unavailable', detail: backendError, retryable: true, hardwareKeyPresent: process.platform !== 'linux' || validateHardwareKey(stateDir) }) },
    { name: 'imessage_setup_status', description: 'Show Linux Matrix/k3s setup requirements; read-only and safe to run at any time.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ platform: process.platform, backend: selectedBackend, hardwareKeyPresent: validateHardwareKey(stateDir), matrixConfigured: Boolean(config.matrix?.homeserverUrl && config.matrix?.accessTokenRef && config.matrix?.roomId), runtime: 'explicit setup required — no k3s install occurs during plugin boot' }) },
  ]

  if (config.fleetTools !== false) {
    ctx.inject(['agentMeshTaskService'], (taskCtx) => {
      const service = (taskCtx as unknown as { agentMeshTaskService: TaskServiceToolMount }).agentMeshTaskService
      for (const tool of tools) service.tools.register(tool)
      // Hardware key distribution (Linux members request, operator fulfills)
      for (const tool of keyTools()) service.tools.register(tool)
    })
  }

  // ── inbound watcher: poll chat.db, deliver allowlisted new messages as
  // fleet-channel system events through the chat plugin's poster. ──
  let timer: ReturnType<typeof setInterval> | undefined
  if (selectedBackend === 'native' && (config.watchMs ?? 2000) > 0) {
    let watermark = -1 // -1 = initialize to MAX(ROWID) on first tick (no replay)
    timer = setInterval(() => void (async () => {
      try {
        if (!(backend instanceof NativeBackend)) return
        if (watermark < 0) { watermark = backend.getWatermark(); return }
        const fresh = backend.fetchSince(watermark)
        if (fresh.length === 0) return
        watermark = fresh[fresh.length - 1]!.rowid
        const ac = await access.get()
        const allowed = (await backend.decorate(fresh)).filter(m => isAllowed(m, ac, ownHandles))
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
    void backend?.stop()
  })

  // Boot-time hardware key check (Linux only)
  if (process.platform === 'linux' && !validateHardwareKey(stateDir)) {
    console.warn('[dsh-imessage] hardware key missing — run the ExtractKey tool on any Mac (see corten-matrix tools/) and place the output at:', join(stateDir, 'hardware-key.bin'))
  }
}
