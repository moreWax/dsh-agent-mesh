import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    inject: vi.fn(), // no task service in the mock: steering tools simply don't mount
    effect: vi.fn((fn: () => () => void) => { effects.push(fn()) }),
  }
  return { ctx, effects, registrations }
}

function upstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}


async function expectDegrade(config: Record<string, unknown>, match: RegExp, name = 'degrade-test', capability: string | null = 'cap'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'serve-degrade-'))
  process.env.SAM_DATA_DIR = dir
  try {
    const { ctx } = mockCtx(capability === null ? undefined : capability)
    await apply(ctx as any, { ...config, announceName: name }) // must NOT throw
    const { readServeStatuses } = await import('@morewax/sam-mesh/node')
    const status = (await readServeStatuses(dir)).find(s => s.name === name)
    expect(status?.state).toBe('error')
    expect(status?.detail).toMatch(match)
  } finally {
    delete process.env.SAM_DATA_DIR
    await rm(dir, { recursive: true, force: true })
  }
}

describe('agent-mesh-inference serve row', () => {
  it('degrades without an explicit target (never crashes dsh)', async () => {
    await expectDegrade({ port: 1 }, /target/)
  })
  it('degrades on non-loopback binds', async () => {
    await expectDegrade({ target: 'http://127.0.0.1:1', host: '0.0.0.0' }, /loopback/)
  })
  it('degrades on ungated config without allowUngated', async () => {
    await expectDegrade({ target: 'http://127.0.0.1:1', port: 1 }, /UNGATED/, 'degrade-test', null)
  })
  it('gates with the agent-mesh capability, announces SERVICE_TYPE_INFERENCE, disposes cleanly', async () => {
    const up = await upstream()
    const port = await freePort()
    const dir = await mkdtemp(join(tmpdir(), 'serve-gate-'))
    process.env.SAM_DATA_DIR = dir
    const { ctx, effects, registrations } = mockCtx('fleet-cap')
    try {
    await apply(ctx as any, { target: up.url, port, announceName: 'test-inference', announceIntervalMs: 1_000_000 })
    const base = `http://127.0.0.1:${port}`
    expect((await fetch(`${base}/v1/models`)).status).toBe(200)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'x-fleet-capability': 'fleet-cap' }, body: '{}' })).status).toBe(200)
    expect(registrations[0]).toMatchObject({ service: { name: 'test-inference', type: 'SERVICE_TYPE_INFERENCE' } })
    expect(effects.length).toBe(1)
    effects[0]!()
    await expect(fetch(base)).rejects.toThrow()
    } finally {
      delete process.env.SAM_DATA_DIR
      await rm(dir, { recursive: true, force: true })
    }
    up.server.close()
  })
})


describe('serve row runtime validation', () => {
  it('degrades on target AND runtime together', async () => {
    await expectDegrade({ target: 'http://127.0.0.1:1', runtime: { model: 'org/repo' } }, /mutually exclusive/)
  })
  it('treats a model-less runtime object as absent (schemastery materializes all-defaulted objects)', async () => {
    await expectDegrade({ runtime: {} }, /target.*or.*runtime|serving is always explicit/)
  })
  it('degrades on a runtime model that is not in the store (boot never downloads)', async () => {
    await expectDegrade({ runtime: { model: 'definitely/not-a-real-repo-xyz:Q8_0' } }, /.+/)
  })
  it('degrades on a missing GGUF path', async () => {
    await expectDegrade({ runtime: { model: '/no/such/model.gguf' } }, /not found/)
  })
})


describe('degrade, never crash', () => {
  it('a fatally-misconfigured row resolves without throwing and writes an error status', async () => {
    await expectDegrade({ target: 'http://127.0.0.1:1', runtime: { model: 'org/repo' } }, /mutually exclusive/)
  })
})
