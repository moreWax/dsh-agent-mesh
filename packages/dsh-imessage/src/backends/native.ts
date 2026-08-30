/**
 * Native macOS backend: reads chat.db directly, sends via osascript.
 * Requires Full Disk Access and Automation permissions (TCC).
 */
import { DatabaseSync } from 'node:sqlite'
import type { IMessageBackend, IMessageBackendMessage } from './interface.js'
import { openMessagesDb, fetchSince, fetchHistory, searchMessages, chatParticipants, currentWatermark, type IMessage } from '../db.js'
import { sendIMessage } from '../sender.js'

export class NativeBackend implements IMessageBackend {
  private db: DatabaseSync | undefined
  private dbError: string | undefined
  private readonly dbPath: string
  private readonly allowSms: boolean

  constructor(dbPath: string, allowSms: boolean) {
    this.dbPath = dbPath
    this.allowSms = allowSms
  }

  private openDb(): DatabaseSync {
    if (this.db) return this.db
    try {
      this.db = openMessagesDb(this.dbPath)
      return this.db
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.dbError = /authorization denied|not authorized|EPERM|EACCES/i.test(msg)
        ? 'Full Disk Access missing — System Settings → Privacy & Security → Full Disk Access → allow your terminal'
        : `cannot open Messages database: ${msg}`
      throw new Error(this.dbError)
    }
  }

  async send(chatGuid: string, text: string, files?: string[]): Promise<{ ok: boolean; chunks?: number; error?: string }> {
    return await sendIMessage(chatGuid, text, files)
  }

  async read(options: { chatGuid?: string; limit?: number }): Promise<IMessageBackendMessage[]> {
    return this.withParticipants(fetchHistory(this.openDb(), { ...options, allowSms: this.allowSms }))
  }

  async search(query: string, limit?: number): Promise<IMessageBackendMessage[]> {
    return this.withParticipants(searchMessages(this.openDb(), query, limit ?? 25, this.allowSms))
  }

  getWatermark(): number { return currentWatermark(this.openDb()) }
  fetchSince(watermark: number): IMessage[] { return fetchSince(this.openDb(), watermark, this.allowSms) }
  getError(): string | undefined { return this.dbError }
  isAvailable(): boolean {
    try { this.openDb(); return true } catch { return false }
  }

  private withParticipants(messages: IMessage[]): IMessageBackendMessage[] {
    if (messages.length === 0) return messages
    const db = this.openDb()
    const map = chatParticipants(db, [...new Set(messages.map(m => m.chatId))])
    return messages.map(m => ({ ...m, participants: map.get(m.chatId) ?? [] }))
  }
}
