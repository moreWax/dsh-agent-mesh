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
import { selectBackend, platformOf, type BackendChoice, type SelectedBackend } from './backends/select.js'
import { loadBackend } from './backends/load.js'
import { BackendController } from './backends/controller.js'
import { SetupStore } from './setup-store.js'
import type { IMessageBackend } from './backends/interface.js'
import { defaultAccess, isAllowed, type AccessFile } from './access.js'

export const name = 'dsh-imessage'
export const inject = ['agentMesh', 'credentials']

export interface Config {
  dbPath?: string
  stateDir?: string
  /** Durable setup progress (default ~/.local/share/dsh-imessage). */
  setupDir?: string
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
  matrix?: { homeserverUrl?: string; accessTokenRef?: string; roomId?: string; bridgeHealthUrl?: string }
  runtime?: { mode?: 'existing-kubernetes' | 'rootless-k3s' | 'external-matrix'; kubeconfig?: string; namespace?: string }
}
export const Config: z<Config> = z.object({
  dbPath: z.string().default('~/Library/Messages/chat.db'),
  stateDir: z.string().default('~/.config/dsh-imessage'),
  setupDir: z.string().default('~/.local/share/dsh-imessage'),
  allowSms: z.boolean().default(false),
  watchMs: z.natural().default(2000),
  signature: z.string().default('\nSent via the mesh'),
  ownHandles: z.array(z.string()).default([]),
  fleetTools: z.boolean().default(true),
  backend: z.union(['auto', 'native', 'matrix']).default('auto'),
  matrix: z.object({ homeserverUrl: z.string(), accessTokenRef: z.string(), roomId: z.string(), bridgeHealthUrl: z.string() }),
  runtime: z.object({ mode: z.union(['existing-kubernetes', 'rootless-k3s', 'external-matrix']), kubeconfig: z.string(), namespace: z.string() }),
}) as unknown as z<Config>

const FDA_FIX = 'Full Disk Access missing — System Settings → Privacy & Security → Full Disk Access → allow your terminal (or the dsh host app)'

function validateHardwareKey(stateDir: string): boolean {
  if (process.platform !== 'linux') return true
  return existsSync(join(stateDir, 'hardware-key.bin'))
}

export function apply(ctx: Context, config: Config = {}): void {
  const dbPath = (config.dbPath ?? '~/Library/Messages/chat.db').replace(/^~(?=\/)/, homedir())
  const stateDir = (config.stateDir ?? '~/.config/dsh-imessage').replace(/^~(?=\/)/, homedir())
  const setupDir = (config.setupDir ?? '~/.local/share/dsh-imessage').replace(/^~(?=\/)/, homedir())

  // Linux setup is explicit and resumable — never install k3s or launch
  // workloads merely because a dsh profile booted. The UI/tools call the
  // setup action after the user chooses an existing cluster or private
  // rootless k3s. This keeps plugin installation side-effect-free.
  const allowSms = config.allowSms === true
  const ownHandles = (config.ownHandles ?? []).map(h => h.trim().toLowerCase())
  const access = new JsonFileView<AccessFile>(join(stateDir, 'access.json'), raw => JSON.parse(raw) as AccessFile, defaultAccess(), async p => (await import('node:fs/promises')).stat(p))

  const controller = new BackendController()
  const setupStore = new SetupStore(setupDir, platformOf())
  let selectedBackend: SelectedBackend = selectBackend(config.backend ?? 'auto')
  let backendError: string | undefined
  let initialization: Promise<void> = Promise.resolve()

  const initialize = async (): Promise<void> => {
    const persisted = await setupStore.recoverInterrupted()
    selectedBackend = selectBackend(config.backend, platformOf(), persisted.backend)
    if (selectedBackend === 'native') {
      await controller.replace(async () => await loadBackend('native', { native: { dbPath, allowSms } }))
      return
    }
    if (selectedBackend === 'matrix') {
      const matrix = config.matrix
      if (!matrix?.homeserverUrl || !matrix.accessTokenRef || !matrix.roomId) {
        backendError = 'Linux iMessage backend needs Matrix homeserver URL, access-token reference, and room ID'
        return
      }
      const resolved = await (ctx as Context & { credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> } }).credentials.resolve(credentialRef(matrix.accessTokenRef))
      if (!resolved?.value) { backendError = 'Matrix access token is not provisioned — store it through dsh credentials'; return }
      await controller.replace(async () => await loadBackend('matrix', { matrix: { homeserverUrl: matrix.homeserverUrl!, accessToken: resolved.value!, roomId: matrix.roomId! } }))
      return
    }
    backendError = `iMessage is unsupported on this platform (${process.platform})`
  }
  initialization = initialize().catch((error: unknown) => { backendError = error instanceof Error ? error.message : String(error) })
  const requireBackend = async (): Promise<IMessageBackend> => {
    await initialization
    const backend = controller.current()
    if (!backend) throw new Error(backendError ?? 'iMessage backend is not configured')
    return backend
  }

  const configuredRuntimeMode = async () => config.runtime?.mode ?? (await setupStore.read()).runtimeMode
  const runtimeForCheck = async () => {
    const mode = await configuredRuntimeMode()
    if (mode === 'existing-kubernetes') {
      const kubeconfig = config.runtime?.kubeconfig?.replace(/^~(?=\/)/, homedir())
      if (!kubeconfig) throw new Error('Existing Kubernetes needs a kubeconfig path')
      const { ExistingKubernetesRuntime } = await import('./runtime/existing-kubernetes.js')
      return new ExistingKubernetesRuntime({ kubeconfig, ...(config.runtime?.namespace ? { namespace: config.runtime.namespace } : {}) })
    }
    if (mode === 'external-matrix') {
      const matrix = config.matrix
      if (!matrix?.homeserverUrl || !matrix.accessTokenRef || !matrix.roomId) throw new Error('External Matrix needs homeserver, room, and credential reference')
      const resolved = await (ctx as Context & { credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> } }).credentials.resolve(credentialRef(matrix.accessTokenRef))
      if (!resolved?.value) throw new Error('Matrix credential is not provisioned')
      const { ExternalMatrixRuntime } = await import('./runtime/external-matrix.js')
      return new ExternalMatrixRuntime({ homeserverUrl: matrix.homeserverUrl, accessToken: resolved.value, roomId: matrix.roomId, ...(matrix.bridgeHealthUrl ? { bridgeHealthUrl: matrix.bridgeHealthUrl } : {}) })
    }
    if (mode === 'rootless-k3s') {
      const { RootlessK3sRuntime } = await import('./runtime/rootless-k3s.js')
      return new RootlessK3sRuntime()
    }
    throw new Error('Select an iMessage runtime before checking it')
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
        return await (await requireBackend()).send({ conversationId: chatGuid, text: text + signature, files })
      } },
    { name: 'imessage_read', description: 'Recent iMessage history as threads (all allowlisted chats, or one chat_guid). Oldest-first per chat.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', properties: { chat_guid: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      handler: async (args: { chat_guid?: unknown; limit?: unknown }) => {
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 100
        const messages = await (await requireBackend()).read({ ...(typeof args.chat_guid === 'string' ? { conversationId: args.chat_guid } : {}), limit })
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
        const messages = await (await requireBackend()).search({ query, limit })
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
      handler: async () => { await initialization; return await controller.status() ?? ({ kind: selectedBackend, state: process.platform === 'linux' ? 'needs_setup' : 'unavailable', detail: backendError, retryable: true, hardwareKeyPresent: process.platform !== 'linux' || validateHardwareKey(stateDir) }) } },
    { name: 'imessage_setup_status', description: 'Show persistent setup progress and requirements; read-only and safe to run at any time.',
      auth: 'capability' as const, requiredScopes: ['tasks'],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ ...(await setupStore.read()), selectedBackend, hardwareKeyPresent: validateHardwareKey(stateDir), matrixConfigured: Boolean(config.matrix?.homeserverUrl && config.matrix?.accessTokenRef && config.matrix?.roomId), runtimePolicy: 'explicit setup required — no k3s install occurs during plugin boot' }) },
    { name: 'imessage_setup_backend', description: 'Persist the setup backend choice. Explicit profile configuration still takes precedence.',
      auth: 'operator' as const,
      schema: { type: 'object', required: ['backend'], properties: { backend: { type: 'string', enum: ['auto', 'native', 'matrix'] } }, additionalProperties: false },
      handler: async (args: { backend?: unknown }) => {
        const choice = args.backend
        if (choice !== 'auto' && choice !== 'native' && choice !== 'matrix') throw new Error('backend must be auto, native, or matrix')
        const saved = await setupStore.update(current => ({ ...current, backend: choice }))
        return { backend: saved.backend, selectedBackend: selectBackend(config.backend, platformOf(), saved.backend), restartRequired: true }
      } },
    { name: 'imessage_runtime_select', description: 'Select a Linux runtime without installing or changing infrastructure.',
      auth: 'operator' as const,
      schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['existing-kubernetes', 'rootless-k3s', 'external-matrix'] } }, additionalProperties: false },
      handler: async (args: { mode?: unknown }) => {
        const mode = args.mode
        if (mode !== 'existing-kubernetes' && mode !== 'rootless-k3s' && mode !== 'external-matrix') throw new Error('invalid runtime mode')
        const saved = await setupStore.update(current => ({ ...current, runtimeMode: mode, runtimeState: current.runtimeState === 'not-selected' ? 'not-installed' : current.runtimeState }))
        return { runtimeMode: saved.runtimeMode, runtimeState: saved.runtimeState, changedInfrastructure: false }
      } },
    { name: 'imessage_runtime_check', description: 'Run non-destructive capability and health checks for the selected runtime.',
      auth: 'operator' as const,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const mode = await configuredRuntimeMode()
        if (!mode) throw new Error('Select a runtime first')
        await setupStore.update(current => ({ ...current, runtimeMode: mode, runtimeState: 'checking', activeStep: 'runtime-check', lastError: null }))
        try {
          const detection = await (await runtimeForCheck()).detect()
          const saved = await setupStore.update(current => ({ ...current, runtimeState: detection.available ? 'ready' : 'failed', activeStep: null, ...(detection.available ? { lastCompletedStep: 'runtime-check', lastError: null } : { lastError: { code: 'IMESSAGE_RUNTIME_CHECK_FAILED', message: 'Runtime requirements are not satisfied', retryable: true, at: new Date().toISOString() } }) }))
          return { ...detection, setupRevision: saved.revision }
        } catch (error) {
          await setupStore.update(current => ({ ...current, runtimeState: 'failed', activeStep: null, lastError: { code: 'IMESSAGE_RUNTIME_CHECK_FAILED', message: error instanceof Error ? error.message : 'Runtime check failed', retryable: true, at: new Date().toISOString() } }))
          throw error
        }
      } },
    { name: 'imessage_runtime_prepare', description: 'Explicitly install/prepare and start the selected runtime. Rootless artifacts are pinned and checksum-verified; no privilege escalation or system services are used.',
      auth: 'operator' as const,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const mode = await configuredRuntimeMode()
        if (!mode) throw new Error('Select a runtime first')
        await setupStore.update(current => ({ ...current, runtimeMode: mode, runtimeState: 'preparing', activeStep: 'runtime-prepare', lastError: null }))
        try {
          const runtime = await runtimeForCheck()
          await runtime.prepare()
          await runtime.start()
          const status = await runtime.status()
          if (status.health !== 'ready') throw new Error(status.detail)
          const saved = await setupStore.update(current => ({ ...current, runtimeState: 'ready', activeStep: null, lastCompletedStep: 'runtime-prepare', lastError: null }))
          return { ...status, setupRevision: saved.revision }
        } catch (error) {
          await setupStore.update(current => ({ ...current, runtimeState: 'failed', activeStep: null, lastError: { code: 'IMESSAGE_RUNTIME_PREPARE_FAILED', message: error instanceof Error ? error.message : 'Runtime preparation failed', retryable: true, at: new Date().toISOString() } }))
          throw error
        }
      } },
    { name: 'imessage_setup_cancel', description: 'Cancel the active setup step without deleting completed work, credentials, or data.',
      auth: 'operator' as const,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => await setupStore.cancel() },
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
        await initialization
        const backend = controller.current() as (IMessageBackend & { getWatermark?: () => number; fetchSince?: (watermark: number) => Array<{ rowid: number; sender: string; isFromMe: boolean; participants: string[]; chatTitle: string | null; text: string | null; attachmentPath?: string; chatGuid: string }>; decorate?: (messages: never[]) => Promise<Array<{ rowid: number; sender: string; isFromMe: boolean; participants: string[]; chatTitle: string | null; text: string | null; attachmentPath?: string; chatGuid: string }>> }) | undefined
        if (!backend?.getWatermark || !backend.fetchSince || !backend.decorate) return
        if (watermark < 0) { watermark = backend.getWatermark(); return }
        const fresh = backend.fetchSince(watermark)
        if (fresh.length === 0) return
        watermark = fresh[fresh.length - 1]!.rowid
        const ac = await access.get()
        const allowed = (await backend.decorate(fresh as never[])).filter(m => isAllowed(m, ac, ownHandles))
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
    void controller.stop()
  })

  // Boot-time hardware key check (Linux only)
  if (process.platform === 'linux' && !validateHardwareKey(stateDir)) {
    console.warn('[dsh-imessage] hardware key missing — run the ExtractKey tool on any Mac (see corten-matrix tools/) and place the output at:', join(stateDir, 'hardware-key.bin'))
  }
}
