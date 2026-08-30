/**
 * Bridge backend for Linux: talks to corten-matrix's Matrix API for
 * iMessage send/read/search. The bridge translates between Matrix rooms
 * and iMessage chats — this backend is a thin HTTP client over that API.
 */
import type { IMessageBackend, IMessageBackendMessage } from './interface.js'

export interface BridgeConfig {
  homeserverUrl: string
  accessToken: string
  roomId: string
}

export class BridgeBackend implements IMessageBackend {
  constructor(private readonly config: BridgeConfig) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.config.homeserverUrl}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        'authorization': `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const data = await res.json() as Record<string, unknown>
    if (!res.ok) throw new Error(`Matrix API ${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`)
    return data
  }

  async send(chatGuid: string, text: string, files?: string[]): Promise<{ ok: boolean; chunks?: number; error?: string }> {
    try {
      const txnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await this.api('PUT', `/rooms/${encodeURIComponent(this.config.roomId)}/send/m.room.message/${txnId}`, {
        msgtype: 'm.text',
        body: text,
      })
      for (const file of files ?? []) {
        // attachments are sent as separate messages
        const uploadRes = await fetch(`${this.config.homeserverUrl}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.split('/').pop() ?? 'file')}`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${this.config.accessToken}`,
            'content-type': 'application/octet-stream',
          },
          body: (await import('node:fs/promises')).readFile(file),
        })
        const upload = await uploadRes.json() as { content_uri?: string }
        if (!upload.content_uri) throw new Error('upload failed')
        await this.api('PUT', `/rooms/${encodeURIComponent(this.config.roomId)}/send/m.room.message/${txnId}-${file}`, {
          msgtype: 'm.file',
          body: file.split('/').pop() ?? 'attachment',
          url: upload.content_uri,
        })
      }
      return { ok: true, chunks: 1 }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async read(options: { chatGuid?: string; limit?: number }): Promise<IMessageBackendMessage[]> {
    const messages: IMessageBackendMessage[] = []
    let from = ''
    let batch = 0
    do {
      const params = new URLSearchParams({ dir: 'b', limit: String(options.limit ?? 100), ...(from ? { from } : {}) })
      const data = await this.api('GET', `/rooms/${encodeURIComponent(this.config.roomId)}/messages?${params}`)
      const chunk: any[] = Array.isArray(data.chunk) ? data.chunk : []
      for (const event of chunk as Record<string, any>[]) {
        if (event.type !== 'm.room.message') continue
        messages.push({
          rowid: messages.length + 1,
          text: typeof event.content?.body === 'string' ? event.content.body : null,
          sender: typeof event.sender === 'string' ? event.sender : 'unknown',
          isFromMe: false,
          date: typeof event.origin_server_ts === 'number' ? event.origin_server_ts : 0,
          chatGuid: options.chatGuid ?? 'bridge',
          chatId: 0,
          chatTitle: null,
          participants: [],
        })
      }
      from = typeof data.end === 'string' ? data.end : ''
      batch++
    } while (from && batch < 5)
    return messages.reverse()
  }

  async search(query: string, limit?: number): Promise<IMessageBackendMessage[]> {
    const data = await this.api('POST', '/search', {
      search_categories: {
        room_events: {
          search_term: query,
          limit: limit ?? 25,
        },
      },
    }) as Record<string, unknown>
    const categories = (data as { search_categories?: { room_events?: { results?: Array<Record<string, unknown>> } } }).search_categories
    const results: any[] = Array.isArray(categories?.room_events?.results) ? categories.room_events.results : []
    return results.map((r: any) => ({
      rowid: 0,
      text: typeof r.content === 'object' && r.content !== null ? String((r.content as Record<string, unknown>).body) : null,
      sender: typeof r.sender === 'string' ? r.sender : 'unknown',
      isFromMe: false,
      date: typeof r.origin_server_ts === 'number' ? r.origin_server_ts : 0,
      chatGuid: r.room_id ?? 'bridge',
      chatId: 0,
      chatTitle: null,
      participants: [],
    }))
  }

  // IMessageBackend compliance
  async send2(chatGuid: string, text: string, files?: string[]): Promise<{ ok: boolean; chunks?: number; error?: string }> {
    return this.send(chatGuid, text, files)
  }
}
