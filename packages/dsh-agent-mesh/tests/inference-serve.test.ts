import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apply } from '../src/inference/plugin.js'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

function mockCtx(capability: string | undefined) {
  const effects: Array<() => void> = []
  const registrations: unknown[] = []
  const ctx = {
    agentMesh: {
      ...(capability !== undefined ? { resolveCallCapability: async () => capability } : {}),
      core: { requestRaw: vi.fn(async (_path: string, opts: { body?: unknown }) => { registrations.push(opts.body); return { status: 200, body: (async function*(){})() } }) },
    },
    credentials: { resolve: vi.fn(async () => undefined) },
    effect: vi.fn((fn: () => () => void) => { effects.push(fn()) }),
  }
  return { ctx, effects, registrations }
}

function upstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

describe('agent-mesh-inference serve row', () => {
  it('refuses to start without an explicit target', async () => {
    const { ctx } = mockCtx('cap')
    await expect(apply(ctx as any, { port: 1 })).rejects.toThrow(/target/)
  })
  it('refuses non-loopback binds', async () => {
    const { ctx } = mockCtx('cap')
    await expect(apply(ctx as any, { target: 'http://127.0.0.1:1', host: '0.0.0.0' })).rejects.toThrow(/loopback/)
  })
  it('refuses to serve ungated without explicit allowUngated', async () => {
    const { ctx } = mockCtx(undefined)
    await expect(apply(ctx as any, { target: 'http://127.0.0.1:1', port: 1 })).rejects.toThrow(/UNGATED/)
  })
  it('gates with the agent-mesh capability, announces SERVICE_TYPE_INFERENCE, disposes cleanly', async () => {
    const up = await upstream()
    const port = await freePort()
    const { ctx, effects, registrations } = mockCtx('fleet-cap')
    await apply(ctx as any, { target: up.url, port, announceName: 'test-inference', announceIntervalMs: 1_000_000 })
    const base = `http://127.0.0.1:${port}`
    expect((await fetch(`${base}/v1/models`)).status).toBe(200)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'fleet-cap' }, body: '{}' })).status).toBe(200)
    expect(registrations[0]).toMatchObject({ service: { name: 'test-inference', type: 'SERVICE_TYPE_INFERENCE' } })
    expect(effects.length).toBe(1)
    effects[0]!()
    await expect(fetch(base)).rejects.toThrow()
    up.server.close()
  })
})
