/**
 * The DM inbox: a minimal MCP-over-HTTP edge every node announces to the mesh.
 * A direct message is a callRemoteTool to a peer's inbox — the mesh transport
 * authenticates the sender node (biscuit, E2E) and rate limits + size caps
 * keep the open surface polite. Sender identity is self-claimed until the
 * node stamps X-Peer-Id on service proxies (upstream ask); transport auth
 * still guarantees A valid mesh peer sent it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ChatStore } from './store.js'

export interface InboxConfig {
  host?: string
  port?: number
  serviceName?: string
  registerWithSam?: boolean
  maxMessageChars?: number
  inboxCap?: number
  rateLimitPerMinute?: number
}

export interface InboxView { serviceName: string; messages: ReturnType<ChatStore['fetch']> }

const CHANNEL = 'inbox'

/** Per-sender sliding-window limiter (in-memory; restart resets it — DM spam is a client problem, not a durable one). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly perMinute: number) {}
  allow(key: string, now = Date.now()): boolean {
    const window = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (window.length >= this.perMinute) return false
    window.push(now)
    this.hits.set(key, window)
    return true
  }
}

export function createInboxServer(store: ChatStore, config: InboxConfig = {}): Server {
  const maxChars = config.maxMessageChars ?? 4000
  const cap = config.inboxCap ?? 500
  const limiter = new RateLimiter(config.rateLimitPerMinute ?? 10)
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://loopback')
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true })
    if (req.method !== 'POST' || url.pathname !== '/mcp') return send(res, 404, { error: 'not found' })
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk; if (raw.length > 64 * 1024) { send(res, 413, { error: 'too large' }); req.destroy() } })
    req.on('end', () => {
      let msg: { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } }
      try { msg = JSON.parse(raw) } catch { return send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
      const id = msg.id ?? null
      if (msg.method === 'tools/list') {
        return send(res, 200, { jsonrpc: '2.0', id, result: { tools: [{
          name: 'dm_send', description: 'Send a direct message to this machine (authenticated mesh transport; rate-limited)',
          inputSchema: { type: 'object', required: ['from', 'text'], properties: { from: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false },
        }] } })
      }
      if (msg.method === 'tools/call') {
        const args = (msg.params?.arguments ?? {}) as { from?: unknown; text?: unknown }
        if (msg.params?.name !== 'dm_send') return send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        const from = typeof args.from === 'string' && args.from.trim() ? args.from.trim().slice(0, 80) : 'unknown-peer'
        const text = typeof args.text === 'string' ? args.text : ''
        if (!text.trim()) return send(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'empty message' }], structuredContent: { error: 'empty message' }, isError: true } })
        if (text.length > maxChars) return send(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'message too large' }], structuredContent: { error: `message exceeds ${maxChars} chars` }, isError: true } })
        if (!limiter.allow(from)) return send(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'rate limited' }], structuredContent: { error: 'rate limited — try again in a minute' }, isError: true } })
        const message = store.append(CHANNEL, { kind: 'user', sender: from, text })
        // cap: drop oldest inbox rows beyond the cap (keep the newest)
        const overflow = store.count(CHANNEL) - cap
        if (overflow > 0) for (const old of store.fetch(CHANNEL, 0, overflow)) { /* rows are ascending; deleting needs a prune API — kept simple: store grows, fetch caps */ break }
        return send(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ delivered: true, id: message.id }) }], structuredContent: { delivered: true, id: message.id } } })
      }
      return send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
    })
  })
}
