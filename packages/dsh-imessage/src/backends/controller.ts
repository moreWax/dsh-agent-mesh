import type { IMessageBackend, IMessageBackendStatus } from './interface.js'
import { IMessageError } from './errors.js'

export type BackendFactory = () => Promise<IMessageBackend>

/** Serializes lifecycle changes. A failed replacement leaves the old backend running. */
export class BackendController {
  private active: IMessageBackend | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  current(): IMessageBackend | undefined { return this.active }

  replace(factory: BackendFactory): Promise<IMessageBackend> {
    let result!: IMessageBackend
    const operation = this.queue.then(async () => {
      if (this.closed) throw new IMessageError('IMESSAGE_BACKEND_UNAVAILABLE', 'The iMessage plugin is stopping', { retryable: true })
      const candidate = await factory()
      try { await candidate.start() } catch (error) { await candidate.stop().catch(() => undefined); throw error }
      if (this.closed) { await candidate.stop(); throw new IMessageError('IMESSAGE_BACKEND_UNAVAILABLE', 'The iMessage plugin stopped during backend startup', { retryable: true }) }
      const previous = this.active
      this.active = candidate
      result = candidate
      if (previous) await previous.stop()
    })
    this.queue = operation.catch(() => undefined)
    return operation.then(() => result)
  }

  async status(): Promise<IMessageBackendStatus | undefined> { return await this.active?.status() }

  async stop(): Promise<void> {
    this.closed = true
    await this.queue
    const active = this.active
    this.active = undefined
    await active?.stop()
  }
}
