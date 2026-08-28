import { describe, expect, it } from 'vitest'
import { SQLiteChatStore } from '../src/store.js'
import { fleetChatTools } from '../src/fleet-channel.js'
import { createInboxServer, RateLimiter } from '../src/inbox.js'
import { listen } from '../tests/util.js'

describe('fleet chat tools', () => {
  it('chat_send attributes the member from the edge context; chat_fetch is cursor-based', async () => {
    const store = new SQLiteChatStore(':memory:')
    const tools = fleetChatTools(store) as Array<{ name: string; handler: (args: Record<string, unknown>, ctx?: { member?: string }) => Promise<unknown> }>
    const send = tools.find(t => t.name === 'chat_send')!.handler
    const fetch = tools.find(t => t.name === 'chat_fetch')!.handler
    const r1 = await send({ text: 'hello' }, { member: 'dsh@MacBookPro' }) as { id: number }
    await send({ text: 'second' }, { member: 'operator' })
    const page = await fetch({ afterId: r1.id }) as { messages: Array<{ sender: string; text: string }> }
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ sender: 'operator', text: 'second' })
    const first = await fetch({}) as { messages: Array<{ sender: string }> }
    expect(first.messages[0]!.sender).toBe('dsh@MacBookPro')
    store.close()
  })
  it('empty text is rejected', async () => {
    const store = new SQLiteChatStore(':memory:')
    const tools = fleetChatTools(store) as Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>
    await expect(tools.find(t => t.name === 'chat_send')!.handler({ text: '   ' })).rejects.toThrow()
    store.close()
  })
})

describe('inbox edge', () => {
  it('delivers a DM, rejects oversized and rate-limited floods', async () => {
    const store = new SQLiteChatStore(':memory:')
    const server = createInboxServer(store, { maxMessageChars: 10, rateLimitPerMinute: 2 })
    const url = await listen(server)
    const call = async (from: string, text: string) => {
      const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dm_send', arguments: { from, text } } }) })
      return (await res.json()) as { result?: { structuredContent?: { delivered?: boolean; error?: string } } }
    }
    expect((await call('mac', 'hi'))?.result?.structuredContent).toMatchObject({ delivered: true })
    expect((await call('mac', 'x'.repeat(20)))?.result?.structuredContent).toMatchObject({ error: expect.stringContaining('exceeds') })
    expect((await call('mac', 'again'))?.result?.structuredContent).toMatchObject({ delivered: true })
    expect((await call('mac', 'third'))?.result?.structuredContent).toMatchObject({ error: expect.stringContaining('rate limited') })
    expect(store.fetch('inbox')).toHaveLength(2)
    server.close(); store.close()
  })
  it('rate limiter window slides', () => {
    const limiter = new RateLimiter(1)
    expect(limiter.allow('p', 1000)).toBe(true)
    expect(limiter.allow('p', 2000)).toBe(false)
    expect(limiter.allow('p', 61_000)).toBe(true)
  })
})
