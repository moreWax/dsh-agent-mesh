/**
 * Durable chat store: one SQLite file, channels as rows. The fleet channel
 * lives on the fleet server; the inbox channel lives on every node. Cursors
 * are monotonic row ids — fetch(after) returns ascending rows.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type ChatKind = 'user' | 'system'

export interface ChatMessage {
  id: number
  channel: string
  kind: ChatKind
  sender: string
  text: string
  ts: number
  meta?: unknown
}

export interface ChatStore {
  append(channel: string, message: Omit<ChatMessage, 'id' | 'channel' | 'ts'> & { ts?: number }): ChatMessage
  fetch(channel: string, afterId?: number, limit?: number): ChatMessage[]
  count(channel: string): number
  close(): void
}

export class SQLiteChatStore implements ChatStore {
  readonly db: DatabaseSync
  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user',
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      meta TEXT
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id)')
  }
  append(channel: string, message: Omit<ChatMessage, 'id' | 'channel' | 'ts'> & { ts?: number }): ChatMessage {
    const ts = message.ts ?? Date.now()
    const meta = message.meta === undefined ? null : JSON.stringify(message.meta)
    const cursor = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get() as { m: number }
    const id = Number(cursor.m) + 1
    this.db.prepare('INSERT INTO messages (id, channel, kind, sender, text, ts, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, channel, message.kind, message.sender, message.text, ts, meta)
    return { id, channel, kind: message.kind, sender: message.sender, text: message.text, ts, ...(message.meta !== undefined ? { meta: message.meta } : {}) }
  }
  fetch(channel: string, afterId = 0, limit = 100): ChatMessage[] {
    const rows = this.db.prepare('SELECT id, channel, kind, sender, text, ts, meta FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(channel, afterId, limit) as Array<{ id: number; channel: string; kind: string; sender: string; text: string; ts: number; meta: string | null }>
    return rows.map(r => ({ id: Number(r.id), channel: r.channel, kind: r.kind as ChatKind, sender: r.sender, text: r.text, ts: Number(r.ts), ...(r.meta ? { meta: JSON.parse(r.meta) } : {}) }))
  }
  count(channel: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel = ?').get(channel) as { c: number }
    return Number(row.c)
  }
  close(): void { this.db.close() }
}
