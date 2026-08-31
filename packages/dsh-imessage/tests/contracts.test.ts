import { afterEach, describe, expect, it, vi } from 'vitest'
import { IMessageError, publicError, redactSensitive } from '../src/backends/errors.js'
import { BridgeBackend } from '../src/backends/bridge.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

describe('stable backend errors', () => {
  it('serializes stable fields but never the cause', () => {
    const error = new IMessageError('IMESSAGE_MATRIX_UNAVAILABLE', 'Matrix unavailable', { detail: 'connection refused', fix: 'Check runtime', retryable: true, cause: new Error('secret cause') })
    expect(error.toJSON()).toEqual({ code: 'IMESSAGE_MATRIX_UNAVAILABLE', message: 'Matrix unavailable', detail: 'connection refused', fix: 'Check runtime', retryable: true })
    expect(JSON.stringify(error)).not.toContain('secret cause')
  })
  it('redacts common credential forms from unknown failures', () => {
    const text = redactSensitive('authorization=Bearer abcdefghijklmnop access_token=syt_12345678901234567890 password=hunter2')
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain('syt_')
    expect(text).not.toContain('hunter2')
    expect(publicError(new Error('password=secret')).code).toBe('IMESSAGE_TRANSIENT')
  })
})

describe('Matrix lifecycle and contract', () => {
  it('starts healthy without exposing the token and returns neutral messages', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(String((init?.headers as Record<string, string>).authorization)).toContain('secret-token')
      return new Response(JSON.stringify(String(_url).includes('whoami') ? { user_id: '@bridge:test' } : { chunk: [{ event_id: '$1', type: 'm.room.message', sender: '@friend:test', origin_server_ts: 1700000000000, content: { body: 'hello' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const backend = new BridgeBackend({ homeserverUrl: 'https://matrix.test', accessToken: 'secret-token', roomId: '!room:test' })
    await backend.start()
    expect(await backend.status()).toMatchObject({ kind: 'matrix', state: 'ready' })
    const [message] = await backend.read({ limit: 1 })
    expect(message).toMatchObject({ id: '$1', backend: 'matrix', conversationId: '!room:test', direction: 'inbound', text: 'hello' })
    expect(JSON.stringify(message)).not.toContain('secret-token')
    await backend.stop()
    expect((await backend.status()).state).toBe('needs_setup')
  })

  it('maps auth rejection to a stable secret-safe error', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'token secret-token rejected' }), { status: 401 })) as typeof fetch
    const backend = new BridgeBackend({ homeserverUrl: 'https://matrix.test', accessToken: 'secret-token', roomId: '!room:test' })
    await expect(backend.start()).rejects.toMatchObject({ code: 'IMESSAGE_ACCESS_DENIED', retryable: false })
    expect(JSON.stringify(await backend.status())).not.toContain('secret-token')
  })
})
