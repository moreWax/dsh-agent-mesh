import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BackendChoice } from './backends/select.js'

export const SETUP_VERSION = 1 as const
export type RuntimeMode = 'existing-kubernetes' | 'rootless-k3s' | 'external-matrix'
export type RuntimeState = 'not-selected' | 'checking' | 'not-installed' | 'preparing' | 'ready' | 'failed'
export type ComponentState = 'unconfigured' | 'checking' | 'configuring' | 'ready' | 'failed'
export type HardwareKeyState = 'missing' | 'requested' | 'validating' | 'ready' | 'invalid'
export type AppleAccountState = 'unconfigured' | 'activating' | 'needs-2fa' | 'ready' | 'failed'

export interface SetupFailure { code: string; message: string; retryable: boolean; at: string }
export interface PersistedSetupState {
  version: typeof SETUP_VERSION
  revision: number
  platform: 'darwin' | 'linux' | 'other'
  backend: BackendChoice
  runtimeMode?: RuntimeMode
  runtimeState: RuntimeState
  matrixState: ComponentState
  bridgeState: ComponentState
  hardwareKeyState: HardwareKeyState
  appleAccountState: AppleAccountState
  lastError: SetupFailure | null
  activeStep: string | null
  lastCompletedStep: string | null
  cancelledAt: string | null
  updatedAt: string
}

export function initialSetupState(platform: PersistedSetupState['platform']): PersistedSetupState {
  return { version: SETUP_VERSION, revision: 0, platform, backend: 'auto', runtimeState: 'not-selected', matrixState: 'unconfigured', bridgeState: 'unconfigured', hardwareKeyState: 'missing', appleAccountState: 'unconfigured', lastError: null, activeStep: null, lastCompletedStep: null, cancelledAt: null, updatedAt: new Date(0).toISOString() }
}

function validate(value: unknown, fallbackPlatform: PersistedSetupState['platform']): PersistedSetupState {
  if (!value || typeof value !== 'object') throw new Error('setup state is not an object')
  const state = value as Partial<PersistedSetupState>
  if (state.version !== SETUP_VERSION) throw new Error(`unsupported setup state version: ${String(state.version)}`)
  if (!['darwin', 'linux', 'other'].includes(String(state.platform))) throw new Error('invalid setup platform')
  if (!['auto', 'native', 'matrix'].includes(String(state.backend))) throw new Error('invalid setup backend')
  // Merge allows compatible additions while the explicit enum checks guard routing fields.
  return { ...initialSetupState(fallbackPlatform), ...state } as PersistedSetupState
}


const RUNTIME_TRANSITIONS: Record<RuntimeState, readonly RuntimeState[]> = {
  'not-selected': ['checking', 'not-installed', 'ready'],
  checking: ['not-installed', 'preparing', 'ready', 'failed'],
  'not-installed': ['checking', 'preparing'],
  preparing: ['ready', 'failed', 'not-installed'],
  ready: ['checking', 'failed'],
  failed: ['checking', 'preparing', 'not-installed'],
}

export function assertSetupTransition(previous: PersistedSetupState, next: PersistedSetupState): void {
  if (previous.platform !== next.platform) throw new Error('setup platform cannot change')
  if (previous.runtimeState !== next.runtimeState && !RUNTIME_TRANSITIONS[previous.runtimeState].includes(next.runtimeState)) {
    throw new Error(`invalid runtime transition: ${previous.runtimeState} -> ${next.runtimeState}`)
  }
  if (next.runtimeState !== 'not-selected' && !next.runtimeMode) throw new Error('runtime mode is required after runtime selection')
  if (next.backend === 'native' && next.platform !== 'darwin') throw new Error('native backend requires macOS')
  if (next.backend === 'matrix' && next.platform !== 'linux') throw new Error('Matrix backend requires Linux')
}

export class SetupLockedError extends Error { readonly code = 'IMESSAGE_SETUP_LOCKED' }

export class SetupStore {
  readonly path: string
  private readonly lockPath: string
  constructor(private readonly stateDir: string, private readonly platform: PersistedSetupState['platform']) {
    this.path = join(stateDir, 'setup.json')
    this.lockPath = join(stateDir, 'setup.lock')
  }

  async read(): Promise<PersistedSetupState> {
    try { return validate(JSON.parse(await readFile(this.path, 'utf8')), this.platform) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialSetupState(this.platform)
      throw error
    }
  }

  async write(next: PersistedSetupState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    const value = validate(next, this.platform)
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}
`); await handle.sync() } finally { await handle.close() }
    await rename(temporary, this.path)
    const directory = await open(dirname(this.path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async update(change: (current: PersistedSetupState) => PersistedSetupState): Promise<PersistedSetupState> {
    return await this.withLock(async () => {
      const current = await this.read()
      const next = change(current)
      assertSetupTransition(current, next)
      const saved = { ...next, version: SETUP_VERSION, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      await this.write(saved)
      return saved
    })
  }

  async withLock<T>(operation: () => Promise<T>, options: { staleMs?: number } = {}): Promise<T> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    try { await mkdir(this.lockPath, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = Date.now() - (await stat(this.lockPath)).mtimeMs
      if (age <= (options.staleMs ?? 15 * 60_000)) throw new SetupLockedError('Another iMessage setup operation is running')
      await rm(this.lockPath, { recursive: true, force: true })
      try { await mkdir(this.lockPath, { mode: 0o700 }) } catch { throw new SetupLockedError('Another iMessage setup operation acquired the lock') }
    }
    try {
      const owner = await open(join(this.lockPath, 'owner.json'), 'wx', 0o600)
      try { await owner.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await owner.sync() } finally { await owner.close() }
      return await operation()
    } finally { await rm(this.lockPath, { recursive: true, force: true }) }
  }

  async begin(step: string): Promise<PersistedSetupState> {
    return await this.update(current => ({ ...current, activeStep: step, lastError: null, cancelledAt: null }))
  }
  async complete(step: string): Promise<PersistedSetupState> {
    return await this.update(current => ({ ...current, activeStep: null, lastCompletedStep: step, lastError: null }))
  }
  async fail(step: string, failure: Omit<SetupFailure, 'at'>): Promise<PersistedSetupState> {
    return await this.update(current => ({ ...current, activeStep: null, lastError: { ...failure, at: new Date().toISOString() }, lastCompletedStep: current.lastCompletedStep }))
  }
  async cancel(): Promise<PersistedSetupState> {
    return await this.update(current => ({ ...current, activeStep: null, cancelledAt: new Date().toISOString() }))
  }
  /** An interrupted active step remains visible and retryable after process restart. */
  async recoverInterrupted(): Promise<PersistedSetupState> {
    const current = await this.read()
    if (!current.activeStep) return current
    return await this.fail(current.activeStep, { code: 'IMESSAGE_SETUP_INTERRUPTED', message: `Setup was interrupted during ${current.activeStep}`, retryable: true })
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Setup cancelled')
}
