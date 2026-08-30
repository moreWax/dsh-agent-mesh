/**
 * The iMessage backend contract. Both backends (native macOS, bridge Linux)
 * implement this — the tools and the fleet see the same surface regardless
 * of which backend serves them.
 */
export interface IMessageBackend {
  /** Send a text to a chat. Returns the delivered message id. */
  send(chatGuid: string, text: string, files?: string[]): Promise<{ ok: boolean; chunks?: number; error?: string }>
  /** Read recent messages, oldest-first per chat. */
  read(options: { chatGuid?: string; limit?: number }): Promise<IMessageBackendMessage[]>
  /** Full-text search across message bodies. */
  search(query: string, limit?: number): Promise<IMessageBackendMessage[]>
}

export interface IMessageBackendMessage {
  rowid: number
  text: string | null
  sender: string
  isFromMe: boolean
  date: number
  chatGuid: string
  chatId: number
  chatTitle: string | null
  participants: string[]
  attachmentPath?: string
}
