import { describe, expect, it } from 'vitest'
import { generatePairKeys, open, seal } from '@morewax/sam-mesh'
import { PairingStore } from '../src/tasks/pairing.js'
import { InMemoryTaskStore, TaskService, type TaskExecutor } from '../src/tasks/service.js'
import { TaskHttpServer } from '../src/tasks/http.js'

const INVITE = JSON.stringify({ version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'fleet-tasks', capability: 'fleet-secret', announcePrivate: false })

describe('ECIES seal/open', () => {
  it('round-trips through the recipient keypair', () => {
    const { publicKeyX, privateKey } = generatePairKeys()
    const sealed = seal(INVITE, publicKeyX)
    expect(sealed.ciphertext).not.toContain('fleet-secret')
    expect(open(sealed, privateKey)).toBe(INVITE)
  })
  it('a different private key cannot open the payload', () => {
    const { publicKeyX } = generatePairKeys()
    const other = generatePairKeys()
    const sealed = seal(INVITE, publicKeyX)
    expect(() => open(sealed, other.privateKey)).toThrow()
  })
})

describe('PairingStore', () => {
  it('request → pending → approve → single-use poll delivers the sealed invite', () => {
    const store = new PairingStore()
    const { publicKeyX, privateKey } = generatePairKeys()
    expect(store.request('r1-0123456789abcdef', publicKeyX, 'macbook')).toBe(true)
    expect(store.pending()).toHaveLength(1)
    expect(store.poll('r1-0123456789abcdef')).toEqual({ state: 'pending' })
    store.approve('r1-0123456789abcdef', INVITE, 'xor')
    const got = store.poll('r1-0123456789abcdef')
    expect(got.state).toBe('approved')
    if (got.state === 'approved') expect(open(got.sealed, privateKey)).toBe(INVITE)
    expect(store.poll('r1-0123456789abcdef')).toEqual({ state: 'unknown' }) // single-use
  })
  it('expired requests disappear; pending cap rejects floods', () => {
    let now = 1_000_000
    const store = new PairingStore({ ttlMs: 1000, maxPending: 2, now: () => now })
    const k = generatePairKeys().publicKeyX
    store.request('a-0123456789abcdef', k, 'one'); store.request('b-0123456789abcdef', k, 'two')
    expect(store.request('c-0123456789abcdef', k, 'three')).toBe(false) // cap
    now += 2000
    expect(store.request('c-0123456789abcdef', k, 'three')).toBe(true) // TTL swept
  })
})

describe('pairing over HTTP with the capability gate on', () => {
  it('request/poll bypass the gate; list/approve require the capability', async () => {
    const pairing = new PairingStore()
    const service = new TaskService(new InMemoryTaskStore(), {} as TaskExecutor, { pairing, pairInvite: () => INVITE })
    const server = new TaskHttpServer(service, { capability: 'fleet-secret' })
    const address = await server.start()
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(address.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      return (await res.json()) as { result?: { structuredContent?: unknown }; error?: { message: string } }
    }
    try {
      const { publicKeyX } = generatePairKeys()
      // ungated: a stranger can REQUEST (that's the point)…
      const req = await call('fleet_pair_request', { requestId: 'rj-0123456789abcdef', publicKey: publicKeyX, label: 'new-laptop' })
      expect(req.error).toBeUndefined()
      // …but cannot LIST (that would reveal pending requests)…
      expect((await call('fleet_pair_list', {})).error?.message).toBe('capability required')
      // …and cannot APPROVE (that would seal the invite to their key).
      expect((await call('fleet_pair_approve', { requestId: 'rj-0123456789abcdef' })).error?.message).toBe('capability required')
      // operator path: with the capability, list + approve work
      const list = await call('fleet_pair_list', { _capability: 'fleet-secret' })
      expect((list.result?.structuredContent as { pending: unknown[] }).pending).toHaveLength(1)
      const approve = await call('fleet_pair_approve', { requestId: 'rj-0123456789abcdef', approvedBy: 'xor', _capability: 'fleet-secret' })
      expect((approve.result?.structuredContent as { approved: boolean }).approved).toBe(true)
    } finally { await server.stop() }
  })
})
