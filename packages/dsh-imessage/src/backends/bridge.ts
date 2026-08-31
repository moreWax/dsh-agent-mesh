/** Matrix/corten bridge backend. Public errors never include Matrix responses or tokens. */
import type { IMessageBackend, IMessageBackendMessage, IMessageBackendStatus, ReadRequest, SearchRequest, SendRequest, SendResult } from './interface.js'
import { IMessageError } from './errors.js'

export interface BridgeConfig { homeserverUrl: string; accessToken: string; roomId: string }

type MatrixEvent = { event_id?: string; type?: string; sender?: string; room_id?: string; origin_server_ts?: number; content?: { body?: string; msgtype?: string; url?: string } }

export class BridgeBackend implements IMessageBackend {
  readonly kind = 'matrix' as const
  private currentStatus: IMessageBackendStatus = { kind: 'matrix', state: 'needs_setup', retryable: true }
  constructor(private readonly config: BridgeConfig) {}

  private url(path: string): string { return `${this.config.homeserverUrl.replace(/\/$/, '')}/_matrix/client/v3${path}` }
  private async api(method: string, path: string, body?: unknown): Promise<any> {
    let response: Response
    try {
      response = await fetch(this.url(path), { method, headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) {
      throw new IMessageError('IMESSAGE_MATRIX_UNAVAILABLE', 'The Matrix homeserver is unavailable', { detail: 'Could not reach the configured homeserver', fix: 'Check the homeserver URL and Matrix runtime status', retryable: true, cause })
    }
    if (response.status === 401 || response.status === 403) throw new IMessageError('IMESSAGE_ACCESS_DENIED', 'Matrix authentication was rejected', { detail: 'The stored Matrix credential is invalid or revoked', fix: 'Replace the Matrix credential in dsh Settings', retryable: false })
    if (response.status === 429) throw new IMessageError('IMESSAGE_RATE_LIMITED', 'Matrix rate limit reached', { retryable: true })
    if (!response.ok) throw new IMessageError(response.status >= 500 ? 'IMESSAGE_MATRIX_UNAVAILABLE' : 'IMESSAGE_TRANSIENT', 'The Matrix request failed', { detail: `Matrix returned HTTP ${response.status}`, retryable: response.status >= 500 })
    return await response.json()
  }

  async start(): Promise<void> {
    try {
      await this.api('GET', '/account/whoami')
      this.currentStatus = { kind: this.kind, state: 'ready', retryable: false, lastHealthyAt: new Date().toISOString() }
    } catch (error) {
      const e = error instanceof IMessageError ? error : new IMessageError('IMESSAGE_MATRIX_UNAVAILABLE', 'The Matrix backend is unavailable', { retryable: true, cause: error })
      this.currentStatus = { kind: this.kind, state: e.code === 'IMESSAGE_ACCESS_DENIED' ? 'needs_matrix_config' : 'degraded', detail: e.message, ...(e.fix ? { fix: e.fix } : {}), retryable: e.retryable }
      throw e
    }
  }
  async stop(): Promise<void> { this.currentStatus = { kind: this.kind, state: 'needs_setup', detail: 'Backend stopped', retryable: true } }
  async status(): Promise<IMessageBackendStatus> { return { ...this.currentStatus } }

  async send(request: SendRequest): Promise<SendResult> {
    const conversationId = request.conversationId || this.config.roomId
    const txn = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const result = await this.api('PUT', `/rooms/${encodeURIComponent(conversationId)}/send/m.room.message/${txn}`, { msgtype: 'm.text', body: request.text }) as { event_id?: string }
    // Attachments remain explicit Matrix messages. Never include local paths in errors.
    for (const [index, file] of (request.files ?? []).entries()) await this.sendFile(conversationId, file, `${txn}-${index}`)
    return { ok: true, chunks: 1, messageId: result.event_id ?? `matrix:${txn}` }
  }

  private async sendFile(room: string, file: string, txn: string): Promise<void> {
    const bytes = await (await import('node:fs/promises')).readFile(file)
    let response: Response
    try { response = await fetch(`${this.config.homeserverUrl.replace(/\/$/, '')}/_matrix/media/v3/upload`, { method: 'POST', headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/octet-stream' }, body: bytes }) }
    catch (cause) { throw new IMessageError('IMESSAGE_MATRIX_UNAVAILABLE', 'The attachment upload failed', { retryable: true, cause }) }
    if (!response.ok) throw new IMessageError('IMESSAGE_TRANSIENT', 'The attachment upload failed', { detail: `Matrix returned HTTP ${response.status}`, retryable: response.status >= 500 })
    const upload = await response.json() as { content_uri?: string }
    if (!upload.content_uri) throw new IMessageError('IMESSAGE_TRANSIENT', 'Matrix did not return an attachment URI', { retryable: true })
    await this.api('PUT', `/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, { msgtype: 'm.file', body: file.split('/').pop() ?? 'attachment', url: upload.content_uri })
  }

  async read(request: ReadRequest): Promise<IMessageBackendMessage[]> {
    const room = request.conversationId || this.config.roomId
    const params = new URLSearchParams({ dir: 'b', limit: String(request.limit ?? 100) })
    const data = await this.api('GET', `/rooms/${encodeURIComponent(room)}/messages?${params}`) as { chunk?: MatrixEvent[] }
    return (Array.isArray(data.chunk) ? data.chunk : []).filter(e => e.type === 'm.room.message').map((e, i) => this.message(e, room, i)).reverse()
  }

  async search(request: SearchRequest): Promise<IMessageBackendMessage[]> {
    const data = await this.api('POST', '/search', { search_categories: { room_events: { search_term: request.query, filter: { rooms: [this.config.roomId] }, limit: request.limit ?? 25 } } }) as { search_categories?: { room_events?: { results?: Array<{ result?: MatrixEvent }> } } }
    return (data.search_categories?.room_events?.results ?? []).map((item, i) => this.message(item.result ?? {}, this.config.roomId, i))
  }

  private message(event: MatrixEvent, room: string, index: number): IMessageBackendMessage {
    const date = event.origin_server_ts ?? 0
    const id = event.event_id ?? `matrix:${date}:${index}`
    const sender = event.sender ?? 'unknown'
    const attachmentPath = event.content?.url
    return { id, backend: this.kind, conversationId: event.room_id ?? room, sender, direction: 'inbound', timestamp: new Date(date).toISOString(), text: event.content?.body ?? null,
      attachments: attachmentPath ? [{ uri: attachmentPath, ...(event.content?.body ? { name: event.content.body } : {}) }] : [], attribution: { backend: this.kind, backendMessageId: id, backendSender: sender, matrixRoomId: event.room_id ?? room, matrixSender: sender },
      rowid: index, isFromMe: false, date, chatGuid: event.room_id ?? room, chatId: 0, chatTitle: null, participants: [], ...(attachmentPath ? { attachmentPath } : {}) }
  }
}
