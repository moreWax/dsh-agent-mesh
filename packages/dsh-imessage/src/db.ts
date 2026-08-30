/**
 * iMessage history + inbound detection against ~/Library/Messages/chat.db.
 * Direct SQLite reads (the Anthropic plugin's model): full native history,
 * watermark-based new-message detection. Read-only — never writes.
 */
import { DatabaseSync } from 'node:sqlite'

export interface IMessage {
  rowid: number
  text: string | null
  /** handle id for inbound; 'me' for outbound */
  sender: string
  isFromMe: boolean
  /** unix ms */
  date: number
  chatGuid: string
  chatId: number
  chatTitle: string | null
  participants: string[]
  attachmentPath?: string
}

/** Apple's epoch: 2001-01-01 in unix ms. */
const APPLE_EPOCH_MS = 978_307_200_000

export function openMessagesDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

export function currentWatermark(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS m FROM message').get() as { m: number }
  return Number(row.m)
}

/** New messages past the watermark (inbound detection), ascending. */
export function fetchSince(db: DatabaseSync, watermark: number, allowSms: boolean): IMessage[] {
  const rows = db.prepare(`
    SELECT m.ROWID AS rowid, m.text, m.is_from_me AS isFromMe, CAST(m.date AS REAL) AS date,
           h.id AS sender, c.guid AS chatGuid, c.ROWID AS chatId, c.display_name AS chatTitle,
           m.service AS service,
           (SELECT a.filename FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID WHERE maj.message_id = m.ROWID LIMIT 1) AS attachmentPath
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.ROWID > ? ${allowSms ? '' : "AND m.service = 'iMessage'"}
    ORDER BY m.ROWID ASC LIMIT 200
  `).all(watermark) as Array<Record<string, unknown>>
  return rows.map(row => toMessage(row))
}

/** Recent history for one chat or all chats, oldest-first per chat. */
export function fetchHistory(db: DatabaseSync, options: { chatGuid?: string; limit?: number; allowSms?: boolean }): IMessage[] {
  const limit = options.limit ?? 100
  const rows = db.prepare(`
    SELECT m.ROWID AS rowid, m.text, m.is_from_me AS isFromMe, CAST(m.date AS REAL) AS date,
           h.id AS sender, c.guid AS chatGuid, c.ROWID AS chatId, c.display_name AS chatTitle,
           m.service AS service,
           (SELECT a.filename FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID WHERE maj.message_id = m.ROWID LIMIT 1) AS attachmentPath
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    ${options.chatGuid ? 'WHERE c.guid = ?' : ''} ${options.allowSms ? '' : (options.chatGuid ? "AND m.service = 'iMessage'" : "WHERE m.service = 'iMessage'")}
    ORDER BY m.ROWID DESC LIMIT ?
  `).all(...(options.chatGuid ? [options.chatGuid, limit] : [limit])) as Array<Record<string, unknown>>
  return rows.map(row => toMessage(row)).reverse()
}

/** Free-text search across message bodies. */
export function searchMessages(db: DatabaseSync, query: string, limit = 25, allowSms = false): IMessage[] {
  const rows = db.prepare(`
    SELECT m.ROWID AS rowid, m.text, m.is_from_me AS isFromMe, CAST(m.date AS REAL) AS date,
           h.id AS sender, c.guid AS chatGuid, c.ROWID AS chatId, c.display_name AS chatTitle,
           m.service AS service
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.text LIKE ? ${allowSms ? '' : "AND m.service = 'iMessage'"}
    ORDER BY m.ROWID DESC LIMIT ?
  `).all(`%${query}%`, limit) as Array<Record<string, unknown>>
  return rows.map(row => toMessage(row))
}

/** Participants per chat (handles joined via chat_handle_join). */
export function chatParticipants(db: DatabaseSync, chatIds: number[]): Map<number, string[]> {
  if (chatIds.length === 0) return new Map()
  const marks = chatIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT chj.chat_id AS chatId, h.id AS handle
    FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
    WHERE chj.chat_id IN (${marks})
  `).all(...chatIds) as Array<{ chatId: number; handle: string }>
  const map = new Map<number, string[]>()
  for (const row of rows) map.set(row.chatId, [...(map.get(row.chatId) ?? []), row.handle])
  return map
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function toMessage(row: Record<string, unknown>): IMessage {
  const dateNs = num(row.date)
  return {
    rowid: num(row.rowid),
    text: typeof row.text === 'string' ? row.text : null,
    sender: row.isFromMe ? 'me' : String(row.sender ?? 'unknown'),
    isFromMe: Boolean(row.isFromMe),
    date: APPLE_EPOCH_MS + dateNs / 1_000_000,
    chatGuid: String(row.chatGuid),
    chatId: num(row.chatId),
    chatTitle: typeof row.chatTitle === 'string' && row.chatTitle ? row.chatTitle : null,
    participants: [],
    ...(typeof row.attachmentPath === 'string' && row.attachmentPath ? { attachmentPath: row.attachmentPath } : {}),
  }
}
