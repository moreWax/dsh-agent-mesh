import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetMemberRegistry } from '../src/tasks/members.js'
import { generatePairKeys, open, seal } from '@morewax/sam-mesh'
import { PairingStore, withPairing, InviteCodes } from '../src/tasks/pairing.js'
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
    const service = withPairing(new TaskService(new InMemoryTaskStore(), {} as TaskExecutor), { store: pairing, inviteFor: () => INVITE })
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


describe('pairing mints per-member capabilities', () => {
  it('approve seals a MEMBER capability, never the shared secret; the member lands in the registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pair-'))
    const registry = new FleetMemberRegistry(join(dir, 'fleet-members.json'))
    const shared = 'shared-operator-secret'
    const service = new TaskService(new InMemoryTaskStore(), { async execute(task) { return task.input ?? null } })
    withPairing(service, {
      inviteFor: async (label: string) => JSON.stringify({
        version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'dsh-task-service',
        capability: (await registry.add(label || 'fleet-member', ['tasks', 'inference'], 'paired')).capability,
      }),
    })
    const { publicKeyX, privateKey } = generatePairKeys()
    service.pairing!.request('r2-0123456789abcdef', publicKeyX, 'macbook')
    await service.pairApprove('r2-0123456789abcdef', 'xor')
    const delivered = service.pairing!.poll('r2-0123456789abcdef') as { state: string; sealed: import('@morewax/sam-mesh').SealedPayload }
    expect(delivered.state).toBe('approved')
    const invite = JSON.parse(open(delivered.sealed!, privateKey)) as { capability: string }
    expect(invite.capability).not.toBe(shared)
    expect(invite.capability).toMatch(/^[0-9a-f]{48}$/)
    const members = await registry.list()
    expect(members).toHaveLength(1)
    expect(members[0]!.name).toBe('macbook')
    expect((await registry.identify(invite.capability, shared))?.member).toBe('macbook')
  })
})


describe('invite codes — possession is the approval', () => {
  it('a valid code auto-approves: sealed on first poll, member minted, no operator round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invite-'))
    const registry = new FleetMemberRegistry(join(dir, 'fleet-members.json'))
    const invites = new InviteCodes()
    const service = new TaskService(new InMemoryTaskStore(), { async execute(task) { return task.input ?? null } })
    withPairing(service, {
      invites,
      inviteFor: async (label: string, scopes?: string[]) => JSON.stringify({
        version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'dsh-task-service',
        capability: (await registry.add(label || 'fleet-member', (scopes?.length ? scopes : ['tasks', 'inference']) as FleetScope[], 'invite')).capability,
        scopes: scopes?.length ? scopes : ['tasks', 'inference'],
      }),
    })
    const created = invites.create(60_000, ['tasks', 'inference'], 'test')
    expect(typeof created.code).toBe('string')

    const { publicKeyX, privateKey } = generatePairKeys()
    // request WITH the code — auto-approves instantly
    const res = await service.callTool('fleet_pair_request', { requestId: 'r3-0123456789abcdef', publicKey: publicKeyX, label: 'laptop', inviteCode: created.code })
    expect(res).toMatchObject({ accepted: true, autoApproved: 'invite-code' })
    const delivered = service.pairing!.poll('r3-0123456789abcdef') as { state: string; sealed: import('@morewax/sam-mesh').SealedPayload }
    expect(delivered.state).toBe('approved')
    const invite = JSON.parse(open(delivered.sealed!, privateKey)) as { capability: string; scopes: string[] }
    expect(invite.scopes).toEqual(['tasks', 'inference'])
    expect((await registry.list())).toHaveLength(1)
    // single-use: the code is dead
    expect(invites.consume(created.code)).toBeUndefined()
  })

  it('a wrong or expired code degrades to the pending queue (a typo never locks anyone out)', async () => {
    const invites = new InviteCodes({ now: () => fakeNow })
    let fakeNow = 1_000
    const service = new TaskService(new InMemoryTaskStore(), { async execute(task) { return task.input ?? null } })
    withPairing(service, { invites, inviteFor: () => JSON.stringify({ version: 1, capability: 'x'.repeat(48) }) })
    const expired = invites.create(100)
    fakeNow += 1_000
    const { publicKeyX } = generatePairKeys()
    await service.callTool('fleet_pair_request', { requestId: 'r4-0123456789abcdef', publicKey: publicKeyX, label: 'a', inviteCode: expired.code })
    expect(service.pairing!.poll('r4-0123456789abcdef')).toEqual({ state: 'pending' })
    await service.callTool('fleet_pair_request', { requestId: 'r5-0123456789abcdef', publicKey: publicKeyX, label: 'b', inviteCode: 'totally-wrong' })
    expect(service.pairing!.poll('r5-0123456789abcdef')).toEqual({ state: 'pending' })
    expect(service.pairPending()).toHaveLength(2)
  })
})
