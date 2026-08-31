import { describe, expect, it } from 'vitest'
import { BackendController } from '../src/backends/controller.js'
import { loadBackend, type BackendModules } from '../src/backends/load.js'
import type { IMessageBackend, IMessageBackendStatus, ReadRequest, SearchRequest, SendRequest, SendResult } from '../src/backends/interface.js'

class FakeBackend implements IMessageBackend {
  readonly kind: 'native' | 'matrix'
  starts = 0; stops = 0
  constructor(kind: 'native' | 'matrix', private readonly startError?: Error) { this.kind = kind }
  async start(): Promise<void> { this.starts++; if (this.startError) throw this.startError }
  async stop(): Promise<void> { this.stops++ }
  async status(): Promise<IMessageBackendStatus> { return { kind: this.kind, state: 'ready', retryable: false } }
  async send(_request: SendRequest): Promise<SendResult> { return { ok: true } }
  async read(_request: ReadRequest) { return [] }
  async search(_request: SearchRequest) { return [] }
}


describe('platform-isolated loading', () => {
  it('loads only the selected implementation', async () => {
    let nativeLoads = 0; let matrixLoads = 0
    const modules: BackendModules = {
      native: async () => { nativeLoads++; return { NativeBackend: class extends FakeBackend { constructor() { super('native') } } } },
      matrix: async () => { matrixLoads++; return { BridgeBackend: class extends FakeBackend { constructor() { super('matrix') } } } },
    }
    expect((await loadBackend('matrix', { matrix: { homeserverUrl: 'x', accessToken: 'secret', roomId: 'r' } }, modules)).kind).toBe('matrix')
    expect(matrixLoads).toBe(1); expect(nativeLoads).toBe(0)
  })
})

describe('backend lifecycle controller', () => {
  it('starts a replacement before stopping the current backend', async () => {
    const controller = new BackendController()
    const native = new FakeBackend('native'); const matrix = new FakeBackend('matrix')
    await controller.replace(async () => native)
    await controller.replace(async () => matrix)
    expect(native.starts).toBe(1); expect(native.stops).toBe(1)
    expect(matrix.starts).toBe(1); expect(controller.current()).toBe(matrix)
    await controller.stop(); expect(matrix.stops).toBe(1)
  })
  it('rolls back when replacement startup fails', async () => {
    const controller = new BackendController()
    const current = new FakeBackend('native'); const broken = new FakeBackend('matrix', new Error('no Matrix'))
    await controller.replace(async () => current)
    await expect(controller.replace(async () => broken)).rejects.toThrow('no Matrix')
    expect(controller.current()).toBe(current); expect(current.stops).toBe(0); expect(broken.stops).toBe(1)
  })
  it('rejects replacement after shutdown', async () => {
    const controller = new BackendController(); await controller.stop()
    await expect(controller.replace(async () => new FakeBackend('native'))).rejects.toMatchObject({ code: 'IMESSAGE_BACKEND_UNAVAILABLE' })
  })
})
