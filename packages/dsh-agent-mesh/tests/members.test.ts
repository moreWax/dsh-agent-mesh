import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetMemberRegistry, mintMemberCapability } from '../src/tasks/members.js'
import { MemberAuthorizer, ToolAllowlistAuthorizer } from '../src/tasks/authz.js'

async function tmpRegistry(): Promise<{ registry: FleetMemberRegistry; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'members-'))
  return { registry: new FleetMemberRegistry(join(dir, 'fleet-members.json')), dir }
}

describe('FleetMemberRegistry', () => {
  it('add → identify → revoke, persisted 0600', async () => {
    const { registry, dir } = await tmpRegistry()
    const member = await registry.add('macbook', ['tasks', 'inference'], 'paired')
    const identity = await registry.identify(member.capability, 'operator-secret')
    expect(identity).toMatchObject({ member: 'macbook', scopes: ['tasks', 'inference'], operator: false })
    // the operator secret identifies as operator with admin
    expect(await registry.identify('operator-secret', 'operator-secret')).toMatchObject({ operator: true })
    // wrong capability identifies nothing
    expect(await registry.identify(mintMemberCapability(), 'operator-secret')).toBeUndefined()
    // 'admin' never granted through pairing
    const adminTry = await registry.add('rogue', ['admin'])
    expect(adminTry.scopes).not.toContain('admin')
    // revoke kills it
    expect(await registry.revoke(member.id)).toBe(true)
    expect(await registry.identify(member.capability, 'operator-secret')).toBeUndefined()
    expect(await registry.revoke(member.id)).toBe(false)
    // persisted file is 0600 and revocation landed on disk
    const path = join(dir, 'fleet-members.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8')).members).toHaveLength(1)
  })

  it('reloads on mtime change without restart (revocation propagation)', async () => {
    const { registry, dir } = await tmpRegistry()
    const member = await registry.add('laptop', ['inference'])
    expect((await registry.identify(member.capability, undefined))?.member).toBe('laptop')
    // external edit: delete the member directly in the file with a NEW mtime
    const path = join(dir, 'fleet-members.json')
    const before = await stat(path)
    await new Promise(r => setTimeout(r, 15))
    await writeFile(path, JSON.stringify({ version: 1, members: [] }, null, 2), { mode: 0o600 })
    const after = await stat(path)
    expect(after.mtimeMs).not.toBe(before.mtimeMs)
    expect(await registry.identify(member.capability, undefined)).toBeUndefined()
  })

  it('missing or unreadable registry = empty fleet (fail closed, never crash)', async () => {
    const registry = new FleetMemberRegistry(join(tmpdir(), 'nope', 'members.json'))
    expect(await registry.list()).toEqual([])
    expect(await registry.identify('anything', undefined)).toBeUndefined()
    const dir = await mkdtemp(join(tmpdir(), 'members-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'members.json'), 'not json')
    const broken = new FleetMemberRegistry(join(dir, 'members.json'))
    expect(await broken.list()).toEqual([])
  })
})

const gatedTool = { name: 'task_submit', description: '', auth: 'capability' as const, schema: {}, handler: async () => ({}) }
const operatorTool = { name: 'fleet_pair_list', description: '', auth: 'operator' as const, schema: {}, handler: async () => ({}) }

describe('MemberAuthorizer', () => {
  const members = [
    { capability: 'member-a-secret', name: 'macbook', scopes: ['tasks'] },
    { capability: 'member-b-secret', name: 'laptop', scopes: ['tasks', 'inference'] },
  ]
  it('a member passes gated tools and is attributed', async () => {
    const authorizer = new MemberAuthorizer(async () => members, 'shared-secret')
    expect(await authorizer.check(gatedTool, {}, { capability: 'member-a-secret' })).toEqual({ allow: true, member: 'macbook' })
  })
  it('a member NEVER passes operator tools — only the shared credential does', async () => {
    const authorizer = new MemberAuthorizer(async () => members, 'shared-secret')
    expect((await authorizer.check(operatorTool, {}, { capability: 'member-a-secret' })).allow).toBe(false)
    expect(await authorizer.check(operatorTool, {}, { capability: 'shared-secret' })).toEqual({ allow: true, member: 'operator' })
  })
  it('wrong/missing capability is uniformly denied', async () => {
    const authorizer = new MemberAuthorizer(async () => members, 'shared-secret')
    for (const presented of [undefined, '', 'nope', 'member-a-secret\u0000']) {
      expect((await authorizer.check(gatedTool, {}, presented === undefined ? {} : { capability: presented })).allow).toBe(false)
    }
  })
  it('scope enforcement: tasks-only member cannot use an inference-scoped tool', async () => {
    const authorizer = new MemberAuthorizer(async () => members, 'shared-secret')
    const inferenceTool = { ...gatedTool, name: 'mesh_inference', requiredScopes: ['inference'] } as typeof gatedTool & { requiredScopes: string[] }
    expect((await authorizer.check(inferenceTool, {}, { capability: 'member-a-secret' })).allow).toBe(false)
    expect((await authorizer.check(inferenceTool, {}, { capability: 'member-b-secret' })).allow).toBe(true)
  })
  it('no operator secret configured = the shared credential no longer works', async () => {
    const authorizer = new MemberAuthorizer(async () => members, undefined)
    expect((await authorizer.check(gatedTool, {}, { capability: 'shared-secret' })).allow).toBe(false)
  })
})

describe('ToolAllowlistAuthorizer', () => {
  it('caps the fleet-facing surface; open tools stay reachable', () => {
    const openTool = { name: 'fleet_pair_request', description: '', auth: 'open' as const, schema: {}, handler: async () => ({}) }
    const authorizer = new ToolAllowlistAuthorizer(['task_submit'])
    expect(authorizer.check(gatedTool).allow).toBe(true)
    expect(authorizer.check({ ...gatedTool, name: 'dangerous_tool' }).allow).toBe(false)
    expect(authorizer.check(openTool).allow).toBe(true)
  })
})
