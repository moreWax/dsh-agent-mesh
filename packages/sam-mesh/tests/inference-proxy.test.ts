import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { capabilityMatches, classifyGate, createInferenceProxyServer, filterModelList, requestModel, detectInferenceBackends, probeBackend, resolveAutoTarget, startAnnounceLoop, WELL_KNOWN_BACKENDS } from '../src/node/inference-proxy.js'

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


describe('capability getter (rotation)', () => {
  it('reads the capability per request, so rotation takes effect without a restart', async () => {
    let current = 'cap-a'
    const upstream = createServer((_req, res) => { res.writeHead(200); res.end('{}') })
    const upstreamUrl = await listen(upstream)
    const proxy = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: upstreamUrl, requiredCapability: () => current })
    const proxyUrl = await listen(proxy)
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap-a' }, body: '{}' })).status).toBe(200)
    current = 'cap-b'
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap-a' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap-b' }, body: '{}' })).status).toBe(200)
    proxy.close(); upstream.close()
  })
})


describe('backend auto-detection', () => {
  it('counts 200 and 401/403 as present, everything else as absent', async () => {
    const withStatus = (status: number) => (async () => ({ status })) as any
    const c = { name: 'x', url: 'http://127.0.0.1:1' }
    expect(await probeBackend(c, withStatus(200))).toBe(true)
    expect(await probeBackend(c, withStatus(401))).toBe(true)
    expect(await probeBackend(c, withStatus(403))).toBe(true)
    expect(await probeBackend(c, withStatus(404))).toBe(false)
    expect(await probeBackend(c, withStatus(500))).toBe(false)
    expect(await probeBackend(c, (async () => { throw new Error('ECONNREFUSED') }) as any)).toBe(false)
  })
  it('resolves deterministically by priority and flags ambiguity', () => {
    const one = resolveAutoTarget([WELL_KNOWN_BACKENDS[2]!])
    expect(one).toMatchObject({ target: 'http://127.0.0.1:8080', ambiguous: false })
    const multi = resolveAutoTarget([WELL_KNOWN_BACKENDS[0]!, WELL_KNOWN_BACKENDS[3]!])
    expect(multi.target).toBe('http://127.0.0.1:11434')
    expect(multi.ambiguous).toBe(true)
    expect(multi.found.map(b => b.name)).toEqual(['ollama', 'vllm'])
  })
  it('throws a loud actionable error when nothing answers', () => {
    expect(() => resolveAutoTarget([])).toThrow(/no OpenAI-compatible backend/)
  })
  it('detects live backends on injected candidates', async () => {
    const alive = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}') })
    const aliveUrl = await listen(alive)
    const res = await detectInferenceBackends([{ name: 'fake', url: aliveUrl }, { name: 'dead', url: 'http://127.0.0.1:1' }])
    expect(res).toMatchObject({ target: aliveUrl, ambiguous: false })
    expect(res.found.map(b => b.name)).toEqual(['fake'])
    alive.close()
  })
})


describe('model allowlist', () => {
  it('filters the listing and blocks disallowed execution models uniformly', async () => {
    const upstream = createServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'public-a' }, { id: 'public-b' }, { id: 'secret-sub' }] })); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
    })
    const upstreamUrl = await listen(upstream)
    const proxy = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: upstreamUrl, requiredCapability: 'cap', modelAllowlist: ['public-a', 'public-b'] })
    const proxyUrl = await listen(proxy)
    // listing filtered
    const listing = await (await fetch(`${proxyUrl}/v1/models`)).json() as { data: Array<{ id: string }> }
    expect(listing.data.map(m => m.id)).toEqual(['public-a', 'public-b'])
    // allowed model executes
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'public-a', messages: [] }) })).status).toBe(200)
    // disallowed model: uniform 404, upstream never touched
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'secret-sub', messages: [] }) })).status).toBe(404)
    // capability gate still applies on top of the allowlist
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'public-a', messages: [] }) })).status).toBe(403)
    proxy.close(); upstream.close()
  })
  it('empty allowlist passes everything through (no buffering regressions)', async () => {
    const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"any"}]}') })
    const upstreamUrl = await listen(upstream)
    const proxy = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: upstreamUrl, requiredCapability: 'cap' })
    const proxyUrl = await listen(proxy)
    const listing = await (await fetch(`${proxyUrl}/v1/models`)).json() as { data: Array<{ id: string }> }
    expect(listing.data.map(m => m.id)).toEqual(['any'])
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'any', messages: [] }) })).status).toBe(200)
    proxy.close(); upstream.close()
  })
  it('getter form re-reads per request', async () => {
    let list = ['a']
    const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    const upstreamUrl = await listen(upstream)
    const proxy = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: upstreamUrl, requiredCapability: 'cap', modelAllowlist: () => list })
    const proxyUrl = await listen(proxy)
    const call = (model: string) => fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap', 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) })
    expect((await call('b')).status).toBe(404)
    list = ['a', 'b']
    expect((await call('b')).status).toBe(200)
    proxy.close(); upstream.close()
  })
})

describe('allowlist helpers', () => {
  it('requestModel reads only a non-empty string model', () => {
    expect(requestModel({ model: 'm' })).toBe('m')
    expect(requestModel({ model: '' })).toBeUndefined()
    expect(requestModel({ model: 3 })).toBeUndefined()
    expect(requestModel(null)).toBeUndefined()
    expect(requestModel('x')).toBeUndefined()
  })
  it('filterModelList keeps id-bearing entries on the list and preserves other fields', () => {
    expect(filterModelList({ object: 'list', data: [{ id: 'a' }, { id: 'b' }, { noId: true }] }, ['a'])).toEqual({ object: 'list', data: [{ id: 'a' }] })
    expect(filterModelList({ nope: 1 }, ['a'])).toBeUndefined()
  })
})
