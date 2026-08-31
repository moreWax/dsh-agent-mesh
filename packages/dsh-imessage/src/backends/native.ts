/** Native macOS backend: read-only chat.db plus argv-safe Messages AppleScript. */
import { DatabaseSync } from 'node:sqlite'
import type { IMessageBackend, IMessageBackendMessage, IMessageBackendStatus, ReadRequest, SearchRequest, SendRequest, SendResult } from './interface.js'
import { IMessageError } from './errors.js'
import { openMessagesDb, fetchSince, fetchHistory, searchMessages, chatParticipants, currentWatermark, type IMessage } from '../db.js'
import { sendIMessage } from '../sender.js'

const FDA_FIX = 'System Settings → Privacy & Security → Full Disk Access → allow the dsh host app or terminal'

export class NativeBackend implements IMessageBackend {
  readonly kind = 'native' as const
  private db: DatabaseSync | undefined
  private currentStatus: IMessageBackendStatus = { kind: 'native', state: 'needs_setup', retryable: true }

  constructor(private readonly dbPath: string, private readonly allowSms: boolean) {}

  async start(): Promise<void> {
    try {
      this.openDb()
      this.currentStatus = { kind: this.kind, state: 'ready', retryable: false, lastHealthyAt: new Date().toISOString() }
    } catch (error) {
      if (error instanceof IMessageError) throw error
      throw this.dbFailure(error)
    }
  }

  async stop(): Promise<void> {
    this.db?.close()
    this.db = undefined
    this.currentStatus = { kind: this.kind, state: 'needs_setup', detail: 'Backend stopped', retryable: true }
  }

  async status(): Promise<IMessageBackendStatus> { return { ...this.currentStatus } }

  private dbFailure(error: unknown): IMessageError {
    const detail = error instanceof Error ? error.message : String(error)
    if (/authorization denied|not authorized|EPERM|EACCES/i.test(detail)) {
      this.currentStatus = { kind: this.kind, state: 'needs_permission', detail: 'Full Disk Access is required to read Messages history', fix: FDA_FIX, retryable: true }
      return new IMessageError('IMESSAGE_PERMISSION_REQUIRED', 'macOS Messages permission is required', { ...(this.currentStatus.detail ? { detail: this.currentStatus.detail } : {}), fix: FDA_FIX, retryable: true, cause: error })
    }
    this.currentStatus = { kind: this.kind, state: 'unavailable', detail: 'Messages database could not be opened', retryable: true }
    return new IMessageError('IMESSAGE_BACKEND_UNAVAILABLE', 'The native iMessage backend is unavailable', { ...(this.currentStatus.detail ? { detail: this.currentStatus.detail } : {}), retryable: true, cause: error })
  }

  private openDb(): DatabaseSync {
    if (this.db) return this.db
    try { this.db = openMessagesDb(this.dbPath); return this.db } catch (error) { throw this.dbFailure(error) }
  }

  async send(request: SendRequest): Promise<SendResult> {
    const result = await sendIMessage(request.conversationId, request.text, request.files)
    if (!result.ok) throw new IMessageError(
      /permission|Automation/i.test(result.error ?? '') ? 'IMESSAGE_PERMISSION_REQUIRED' : 'IMESSAGE_TRANSIENT',
      /permission|Automation/i.test(result.error ?? '') ? 'macOS Messages automation permission is required' : 'The message could not be sent',
      { detail: /permission|Automation/i.test(result.error ?? '') ? 'Messages automation access has not been granted' : 'Messages rejected or could not complete the send operation', ...(/permission|Automation/i.test(result.error ?? '') ? { fix: 'System Settings → Privacy & Security → Automation → allow dsh to control Messages' } : {}), retryable: true },
    )
    return { ok: true, chunks: result.chunks, messageId: `native:${Date.now()}` }
  }

  async read(request: ReadRequest): Promise<IMessageBackendMessage[]> {
    return this.withParticipants(fetchHistory(this.openDb(), { ...(request.conversationId ? { chatGuid: request.conversationId } : {}), ...(request.limit ? { limit: request.limit } : {}), allowSms: this.allowSms }))
  }

  async search(request: SearchRequest): Promise<IMessageBackendMessage[]> {
    return this.withParticipants(searchMessages(this.openDb(), request.query, request.limit ?? 25, this.allowSms))
  }

  getWatermark(): number { return currentWatermark(this.openDb()) }
  fetchSince(watermark: number): IMessage[] { return fetchSince(this.openDb(), watermark, this.allowSms) }

  async decorate(messages: IMessage[]): Promise<IMessageBackendMessage[]> { return this.withParticipants(messages) }

  private withParticipants(messages: IMessage[]): IMessageBackendMessage[] {
    if (messages.length === 0) return []
    const map = chatParticipants(this.openDb(), [...new Set(messages.map(m => m.chatId))])
    return messages.map(m => {
      const participants = map.get(m.chatId) ?? []
      const attachment = m.attachmentPath ? [{ path: m.attachmentPath, ...(m.attachmentPath.split('/').pop() ? { name: m.attachmentPath.split('/').pop()! } : {}) }] : []
      return {
        ...m, participants, id: `native:${m.rowid}`, backend: this.kind,
        conversationId: m.chatGuid, direction: m.isFromMe ? 'outbound' : 'inbound',
        timestamp: new Date(m.date).toISOString(), attachments: attachment,
        attribution: { backend: this.kind, backendMessageId: String(m.rowid), imessageHandle: m.sender },
      }
    })
  }
}
