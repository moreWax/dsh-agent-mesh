import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { FailureLimiter } from '../src/core/failure-limiter.js'
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

    // Bearer alias: the standard OpenAI credential slot carries the same
    // capability — stock clients without a custom-header feature can execute.
    res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer fleet-cap' }, body: '{}' })
    expect(res.status).toBe(200)
    // ...and the capability never leaks upstream: Authorization is still replaced.
    expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer upstream-key', capability: undefined })

    // wrong Bearer -> same uniform 403
    res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
    expect(res.status).toBe(403)

    // precedence locked: a present (wrong) x-fleet-capability beats a right Bearer
    res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'nope', authorization: 'Bearer fleet-cap' }, body: '{}' })
    expect(res.status).toBe(403)

    proxy.close(); upstream.close()
  })

  it('per-member tokens: members execute, wrong-scope members 403, operator still works', async () => {
    const seen: unknown[] = []
    const upstream = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    const upstreamUrl = await listen(upstream)
    const logs: string[] = []
    const proxy = createInferenceProxyServer({
      host: '127.0.0.1', port: 0, target: upstreamUrl,
      requiredCapability: () => 'shared-op-secret',
      gateTokens: () => [
        { token: 'mac-cap', member: 'macbook', scopes: ['tasks', 'inference'] },
        { token: 'tasks-only-cap', member: 'macbook-tasks-only', scopes: ['tasks'] },
      ],
      onLog: line => logs.push(line),
    })
    const proxyUrl = await listen(proxy)

    // member with inference scope executes
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'mac-cap' }, body: '{"model":"m"}' })).status).toBe(200)
    expect(logs.some(l => l.includes('EXEC') && l.includes('member=macbook'))).toBe(true)

    // member WITHOUT inference scope is denied with a scope-annotated log
    const before = logs.length
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'tasks-only-cap' }, body: '{}' })).status).toBe(403)
    expect(logs.slice(before).some(l => l.includes('DENY') && l.includes('scope'))).toBe(true)

    // the shared secret still works (operator, migration posture)
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'shared-op-secret' }, body: '{}' })).status).toBe(200)
    expect(logs.some(l => l.includes('operator'))).toBe(true)

    // revocation = token set drops the member on the next request
    let revoked = false
    const gate = () => {
      const tokens: { token: string; member?: string; scopes?: string[] }[] = [
        { token: 'mac-cap', member: 'macbook', scopes: ['inference'] },
      ]
      if (!revoked) tokens.push({ token: 'gone-cap', member: 'gone', scopes: ['inference'] })
      return tokens
    }
    const proxy2 = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: upstreamUrl, requiredCapability: () => '', gateTokens: gate })
    const url2 = await listen(proxy2)
    expect((await fetch(`${url2}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'gone-cap' }, body: '{}' })).status).toBe(200)
    revoked = true
    expect((await fetch(`${url2}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'gone-cap' }, body: '{}' })).status).toBe(403)

    proxy.close(); proxy2.close(); upstream.close()
  })

  it('bounds the buffered body: 413 past the cap', async () => {
    const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    // an allowlist forces the buffering path
    const proxy = createInferenceProxyServer({
      host: '127.0.0.1', port: 0, target: await listen(upstream),
      requiredCapability: 'cap', modelAllowlist: ['tiny'], maxBodyBytes: 64,
    })
    const proxyUrl = await listen(proxy)
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap' }, body: JSON.stringify({ model: 'tiny', pad: 'x'.repeat(200) }) })).status).toBe(413)
    // under the cap still flows
    expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'cap' }, body: '{"model":"tiny"}' })).status).toBe(200)
    proxy.close(); upstream.close()
  })
describe('FailureLimiter (denial flood control)', () => {
  it('throttles past the window and logs sparsely', () => {
    const limiter = new FailureLimiter({ perWindow: 2, logEvery: 2 })
    expect(limiter.deny('k', 1000)).toEqual({ throttled: false, log: true })
    expect(limiter.deny('k', 2000)).toEqual({ throttled: false, log: true })
    expect(limiter.deny('k', 3000)).toEqual({ throttled: true, log: true })   // 1st throttled
    expect(limiter.deny('k', 4000)).toEqual({ throttled: true, log: false })  // suppressed
    expect(limiter.deny('k', 70_000)).toEqual({ throttled: false, log: true }) // window slid
  })
  it('keys a credential by digest — never the secret', () => {
    expect(FailureLimiter.keyOf(undefined)).toBe('no-credential')
    const key = FailureLimiter.keyOf('some-secret')
    expect(key).toHaveLength(16)
    expect(key).not.toContain('secret')
  })
  it('the gate throttles a flooding wrong token', async () => {
    const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    const logs: string[] = []
    const proxy = createInferenceProxyServer({ host: '127.0.0.1', port: 0, target: await listen(upstream), requiredCapability: 'right', denyPerWindow: 3, onLog: line => logs.push(line) })
    const proxyUrl = await listen(proxy)
    for (let i = 0; i < 8; i++) {
      expect((await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'wrong' }, body: '{}' })).status).toBe(403)
    }
    const denies = logs.filter(l => l.includes('DENY'))
    expect(denies.length).toBeLessThan(8)
    expect(denies.some(l => l.includes('throttled'))).toBe(true)
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

})