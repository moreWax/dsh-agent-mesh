import { describe, expect, it } from 'vitest'
import { ToolRegistry, type ToolDescriptor } from '../src/tasks/tools.js'
import { CapabilityAuthorizer, extractCredentials, runAuthorizers } from '../src/tasks/authz.js'

const tool = (auth: ToolDescriptor['auth'], name = 't'): ToolDescriptor => ({
  name, description: 'd', schema: { type: 'object' }, auth, handler: async () => null,
})

describe('ToolRegistry', () => {
  it('rejects duplicate names — a registry is the single source, collisions are bugs', () => {
    const r = new ToolRegistry()
    r.register(tool('open'))
    expect(() => r.register(tool('open'))).toThrow(/duplicate/)
  })
  it('lists in registration order with the wire shape', () => {
    const r = new ToolRegistry()
    r.register(tool('open', 'a')).register(tool('capability', 'b'))
    expect(r.list().map(t => t.name)).toEqual(['a', 'b'])
    expect(r.list()[0]).toHaveProperty('inputSchema')
  })
})

describe('CapabilityAuthorizer', () => {
  const gate = new CapabilityAuthorizer('secret')
  it('open tools pass without credentials; gated tools need the exact secret', () => {
    expect(gate.check(tool('open'), {}, {}).allow).toBe(true)
    expect(gate.check(tool('capability'), {}, {}).allow).toBe(false)
    expect(gate.check(tool('operator'), {}, {}).allow).toBe(false)
    expect(gate.check(tool('capability'), {}, { capability: 'secret' }).allow).toBe(true)
  })
  it('missing and wrong are the same verdict — no oracle', () => {
    const missing = gate.check(tool('capability'), {}, {})
    const wrong = gate.check(tool('capability'), {}, { capability: 'nope' })
    expect(missing).toEqual(wrong)
  })
  it('runAuthorizers short-circuits on first denial', () => {
    const calls: string[] = []
    const spy = (name: string, allow: boolean) => ({ name, check: () => { calls.push(name); return allow ? { allow: true as const } : { allow: false as const, message: name } } })
    const verdict = runAuthorizers([spy('a', true), spy('b', false), spy('c', true)], tool('capability'), {}, {})
    expect(verdict).toEqual({ allow: false, message: 'b' })
    expect(calls).toEqual(['a', 'b']) // c never ran
  })
})

describe('extractCredentials', () => {
  it('pulls _capability out and never lets it reach the handler args', () => {
    const { args, ctx } = extractCredentials({ taskId: 't1', _capability: 's' })
    expect(args).toEqual({ taskId: 't1' })
    expect(ctx).toEqual({ capability: 's' })
  })
  it('non-string capabilities are dropped', () => {
    const { ctx } = extractCredentials({ _capability: 42 as unknown as string })
    expect(ctx.capability).toBeUndefined()
  })
})
