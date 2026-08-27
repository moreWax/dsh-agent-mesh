import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { downloadModel, LlamaRuntime, readServeStatuses, writeServeStatus } from '../src/node/index.js'

describe('serve status files', () => {
  it('round-trips states and tolerates corrupt entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'serve-status-'))
    try {
      expect(await readServeStatuses(dir)).toEqual([])
      await writeServeStatus(dir, { state: 'starting', name: 'a b', detail: 'loading' })
      await writeServeStatus(dir, { state: 'serving', name: 'c', target: 'http://127.0.0.1:1' })
      await mkdir(join(dir, 'serve'), { recursive: true })
      await writeFile(join(dir, 'serve', 'broken.json'), '{nope')
      const statuses = await readServeStatuses(dir)
      expect(statuses).toHaveLength(2)
      expect(statuses.find(s => s.name === 'a b')).toMatchObject({ state: 'starting', detail: 'loading' })
      expect(statuses.find(s => s.name === 'c')?.updatedAt).toBeTruthy()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((r) => probe.close(() => r()))
  return port
}

describe('orphan adoption', () => {
  it('reclaims the port from a stale llama-server pidfile, refuses a foreign process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llama-orphan-'))
    const port = await freePort()
    // fake llama-server: script whose cmdline contains 'llama-server', holding the port
    const fakePath = join(dir, 'llama-server')
    await mkdir(join(dir, 'runtime'), { recursive: true })
    // argv0 spoof: /proc/<pid>/cmdline contains 'llama-server' (the identity check reads it)
    const orphan = spawn('node', ['-e', `require('node:net').createServer().listen(${port},'127.0.0.1')`], { stdio: 'ignore', argv0: fakePath })
    await new Promise(r => setTimeout(r, 400))
    await writeFile(join(dir, 'runtime', `llama-${port}.json`), JSON.stringify({ pid: orphan.pid, port }))
    try {
      const rt = new LlamaRuntime({ binary: '/bin/false', libDir: dir, tag: 'test' }, { modelPath: '/x.gguf', alias: 'x', port, dataDir: dir })
      // reclaims the orphan, then fails spawning /bin/false — the orphan must be gone
      await expect(rt.start(2000)).rejects.toThrow()
      await new Promise(r => setTimeout(r, 300))
      expect(() => process.kill(orphan.pid!, 0)).toThrow()
      // a FOREIGN process with a pidfile must NOT be killed
      const foreign = createServer()
      await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', () => r()))
      await writeFile(join(dir, 'runtime', `llama-${port}.json`), JSON.stringify({ pid: process.pid, port }))
      const rt2 = new LlamaRuntime({ binary: '/bin/false', libDir: dir, tag: 'test' }, { modelPath: '/x.gguf', alias: 'x', port, dataDir: dir })
      await expect(rt2.start(2000)).rejects.toThrow(/non-llama/)
      foreign.close()
    } finally {
      try { process.kill(orphan.pid!, 'SIGKILL') } catch { /* already reclaimed */ }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('download integrity', () => {
  it('verifies the HF lfs sha256 and deletes mismatches', async () => {
    const { createHash } = await import('node:crypto')
    const payload = Buffer.alloc(8192, 3)
    const good = createHash('sha256').update(payload).digest('hex')
    let sha = good
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ siblings: [{ rfilename: 'm.gguf', size: payload.length, lfs: { oid: sha } }] })); return }
      res.writeHead(200, { 'content-length': String(payload.length) }); res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const dir = await mkdtemp(join(tmpdir(), 'llama-dl-'))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init?: any) => realFetch(String(url).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as any
    try {
      const out = await downloadModel(dir, { kind: 'hf', repo: 'o/r' })
      expect(existsSync(out.path)).toBe(true)
      sha = 'deadbeef'
      await expect(downloadModel(dir, { kind: 'hf', repo: 'o/r', file: 'm.gguf' })).rejects.toThrow(/integrity check failed/)
      expect(existsSync(join(dir, 'models', 'o_r--m.gguf.part-' + process.pid))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
      server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
