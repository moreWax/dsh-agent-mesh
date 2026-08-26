import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { capabilityMatches, classifyGate, createInferenceProxyServer, startAnnounceLoop } from '../src/node/inference-proxy.js'

describe('classifyGate', () => {
  it('opens only GET /v1/models', () => {
    expect(classifyGate('GET', '/v1/models')).toBe('open')
    expect(classifyGate('GET', '/v1/models/')).toBe('open')
    expect(classifyGate('POST', '/v1/models')).toBe('gated')
    expect(classifyGate('POST', '/v1/chat/completions')).toBe('gated')
    expect(classifyGate('GET', '/v1/chat/completions')).toBe('gated')
    expect(classifyGate('POST', '/v1/embeddings')).toBe('gated')
  })
})

describe('capabilityMatches', () => {
  it('accepts the exact capability and rejects everything else', () => {
    expect(capabilityMatches('cap-123', 'cap-123')).toBe(true)
    expect(capabilityMatches('cap-124', 'cap-123')).toBe(false)
    expect(capabilityMatches('cap-12', 'cap-123')).toBe(false)
    expect(capabilityMatches(undefined, 'cap-123')).toBe(false)
    expect(capabilityMatches('cap-123', '')).toBe(false)
  })
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('inference proxy (http)', () => {
  it('passes listing without a capability, gates execution, strips + injects headers', async () => {
    const seen: Array<{ authorization?: string; capability?: string; path?: string }> = []
    const upstream = createServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, capability: req.headers['x-fleet-capability'] as string | undefined, path: req.url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const upstreamUrl = await listen(upstream)
    const proxy = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: upstreamUrl, upstreamAuth: 'upstream-key', requiredCapability: 'fleet-cap' })
    const proxyUrl = await listen(proxy)

    // open listing: no capability required, upstream auth injected, capability stripped
    let res = await fetch(`${proxyUrl}/v1/models`)
    expect(res.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer upstream-key', capability: undefined, path: '/v1/models' })

    // gated execution: missing capability -> uniform 403, upstream never touched
    const before = seen.length
    res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect(seen.length).toBe(before)

    // wrong capability -> 403
    res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'nope' }, body: '{}' })
    expect(res.status).toBe(403)
    expect(seen.length).toBe(before)

    // right capability -> forwarded, capability stripped, inbound Authorization replaced
    res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'fleet-cap', authorization: 'Bearer attacker' }, body: '{}' })
    expect(res.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer upstream-key', capability: undefined, path: '/v1/chat/completions' })

    proxy.close(); upstream.close()
  })
})

describe('startAnnounceLoop', () => {
  it('registers as SERVICE_TYPE_INFERENCE and re-announces until stopped', async () => {
    const calls: unknown[] = []
    const stop = startAnnounceLoop({
      register: async (body) => { calls.push(body) },
      name: 'morewax-gpu-inference', targetUrl: 'http://127.0.0.1:4100', intervalMs: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 45))
    stop()
    const count = calls.length
    expect(count).toBeGreaterThan(1)
    expect(calls[0]).toMatchObject({ service: { name: 'morewax-gpu-inference', type: 'SERVICE_TYPE_INFERENCE' }, target_url: 'http://127.0.0.1:4100' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(calls.length).toBe(count)
  })

  it('tolerates register failures and keeps retrying', async () => {
    let calls = 0
    const stop = startAnnounceLoop({ register: async (): Promise<never> => { calls++; throw new Error('node booting') }, name: 'x', targetUrl: 'http://127.0.0.1:1', intervalMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 35))
    stop()
    expect(calls).toBeGreaterThan(1)
  })
})
