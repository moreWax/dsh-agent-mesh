import { describe, expect, it, vi } from 'vitest'
import { autoNode } from '../src/index.js'

function fakeManager(over: Record<string, unknown> = {}) {
  const calls = { start: [] as unknown[], begin: [] as unknown[] }
  const manager = {
    status: async () => ({ installed: true, enrolled: false, running: false, pid: null, ...over.status as object }),
    start: vi.fn(async (opts?: unknown) => { calls.start.push(opts); return { ok: true as const, message: 'started' } }),
    beginEnrollment: vi.fn((opts?: unknown) => {
      calls.begin.push(opts)
      return {
        sessionId: 's1',
        done: Promise.resolve(),
        cancel: vi.fn(),
        info: () => ({ state: 'complete', mode: 'bootstrap', error: null as string | null }),
      }
    }),
  }
  return { manager, calls }
}

const decisions = { autoStartNode: true, autoBeginEnrollment: true, nodeControlPlane: 'https://cp.example' }

describe('autoNode bootstrap flow', () => {
  it('bootstrap token present: enrolls unattended and chains into start with the managed api token', async () => {
    const { manager, calls } = fakeManager()
    const outcome = await autoNode(manager as never, decisions, {
      resolveEnrollmentToken: async () => 'sam-bt-abc',
      ensureNodeToken: async () => 'managed-api-token',
    }, () => {})
    expect(calls.begin[0]).toMatchObject({ controlPlane: 'https://cp.example', bootstrapToken: 'sam-bt-abc' })
    expect(calls.start[0]).toEqual({ apiToken: 'managed-api-token' })
    expect(outcome.started).toBe(true)
  })

  it('no bootstrap token: begins the device flow and does NOT chain into start', async () => {
    const { manager, calls } = fakeManager()
    const outcome = await autoNode(manager as never, decisions, {
      resolveEnrollmentToken: async () => undefined,
      ensureNodeToken: async () => 'managed-api-token',
    }, () => {})
    expect(calls.begin[0]).toEqual({ controlPlane: 'https://cp.example' })
    expect(calls.start).toHaveLength(0)
    expect(outcome.started).toBe(false)
  })

  it('enrolled + stopped: starts with the managed api token', async () => {
    const { manager, calls } = fakeManager({ status: { enrolled: true } })
    const outcome = await autoNode(manager as never, decisions, {
      ensureNodeToken: async () => 'managed-api-token',
    }, () => {})
    expect(calls.start[0]).toEqual({ apiToken: 'managed-api-token' })
    expect(outcome.started).toBe(true)
  })

  it('failed bootstrap enrollment does not start the node', async () => {
    const { manager, calls } = fakeManager()
    manager.beginEnrollment.mockImplementationOnce(() => ({
      sessionId: 's1', done: Promise.resolve(), cancel: vi.fn(),
      info: () => ({ state: 'failed', mode: 'bootstrap', error: 'token expired' }),
    }))
    const outcome = await autoNode(manager as never, decisions, {
      resolveEnrollmentToken: async () => 'sam-bt-expired',
    }, () => {})
    expect(calls.start).toHaveLength(0)
    expect(outcome.started).toBe(false)
  })
})
