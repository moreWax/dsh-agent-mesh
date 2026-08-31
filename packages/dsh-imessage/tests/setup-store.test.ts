import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SetupLockedError, SetupStore, initialSetupState, throwIfCancelled } from '../src/setup-store.js'

const dirs: string[] = []
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'dsh-imessage-')); dirs.push(dir); return { dir, store: new SetupStore(dir, 'linux') } }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('persistent setup store', () => {
  it('uses an initial state and writes atomic private state', async () => {
    const { store } = await fixture()
    expect((await store.read()).runtimeState).toBe('not-selected')
    const saved = await store.update(current => ({ ...current, backend: 'matrix', runtimeMode: 'external-matrix', runtimeState: 'ready' }))
    expect(saved.revision).toBe(1); expect((await store.read()).backend).toBe('matrix')
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await readFile(store.path, 'utf8')).toContain('external-matrix')
  })
  it('ignores an interrupted temporary write and retains the last committed state', async () => {
    const { dir, store } = await fixture()
    await store.update(current => ({ ...current, backend: 'matrix' }))
    await (await import('node:fs/promises')).writeFile(join(dir, 'setup.json.crashed.tmp'), '{broken', { mode: 0o600 })
    expect((await store.read()).backend).toBe('matrix')
  })
  it('blocks concurrent setup operations', async () => {
    const { store } = await fixture()
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const held = store.withLock(async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
    await ready
    await expect(store.withLock(async () => undefined)).rejects.toBeInstanceOf(SetupLockedError)
    release(); await held
  })
  it('recovers an abandoned stale lock', async () => {
    const { dir, store } = await fixture()
    const lock = join(dir, 'setup.lock'); await (await import('node:fs/promises')).mkdir(lock, { recursive: true })
    const old = new Date(Date.now() - 60_000); await utimes(lock, old, old)
    await expect(store.withLock(async () => 'ok', { staleMs: 10 })).resolves.toBe('ok')
  })
  it('turns an interrupted active step into a retryable failure', async () => {
    const { store } = await fixture(); await store.begin('runtime-download')
    const recovered = await store.recoverInterrupted()
    expect(recovered.activeStep).toBeNull(); expect(recovered.lastError).toMatchObject({ code: 'IMESSAGE_SETUP_INTERRUPTED', retryable: true })
  })
  it('cancels without erasing completed progress', async () => {
    const { store } = await fixture(); await store.complete('runtime-ready'); const cancelled = await store.cancel()
    expect(cancelled.lastCompletedStep).toBe('runtime-ready'); expect(cancelled.cancelledAt).not.toBeNull()
    const abort = new AbortController(); abort.abort(new Error('stop'))
    expect(() => throwIfCancelled(abort.signal)).toThrow('stop')
  })
  it('rejects impossible platform and runtime transitions', async () => {
    const { store } = await fixture()
    await expect(store.update(current => ({ ...current, backend: 'native' }))).rejects.toThrow('native backend requires macOS')
    await store.update(current => ({ ...current, runtimeMode: 'rootless-k3s', runtimeState: 'not-installed' }))
    await expect(store.update(current => ({ ...current, runtimeState: 'ready' }))).rejects.toThrow('invalid runtime transition')
  })
  it('rejects unknown state versions rather than silently resetting', async () => {
    const { store } = await fixture(); await store.write(initialSetupState('linux'))
    const raw = JSON.parse(await readFile(store.path, 'utf8')); raw.version = 999
    await (await import('node:fs/promises')).writeFile(store.path, JSON.stringify(raw), { mode: 0o600 })
    await expect(store.read()).rejects.toThrow('unsupported setup state version')
  })
})
