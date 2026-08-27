import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadModel, listModelStore, modelStorePath, parseModelSpec, resolveHfFile } from '../src/node/llama-runtime.js'

describe('parseModelSpec', () => {
  it('parses every supported form', () => {
    expect(parseModelSpec('org/repo')).toEqual({ kind: 'hf', repo: 'org/repo' })
    expect(parseModelSpec('org/repo:Q4_K_M')).toEqual({ kind: 'hf', repo: 'org/repo', quant: 'Q4_K_M' })
    expect(parseModelSpec('org/repo/model-x.gguf')).toEqual({ kind: 'hf', repo: 'org/repo', file: 'model-x.gguf' })
    expect(parseModelSpec('/abs/model.gguf')).toEqual({ kind: 'path', path: '/abs/model.gguf' })
    expect(parseModelSpec('~/models/x.gguf')).toEqual({ kind: 'path', path: '~/models/x.gguf' })
    expect(parseModelSpec('local.gguf')).toEqual({ kind: 'path', path: 'local.gguf' })
  })
  it('rejects garbage loudly', () => {
    expect(() => parseModelSpec('')).toThrow(/empty/)
    expect(() => parseModelSpec('norepo')).toThrow(/model spec must be/)
  })
})

describe('resolveHfFile', () => {
  const api = (files: Array<{ rfilename: string; size?: number }>) => (async () => ({ ok: true, status: 200, json: async () => ({ siblings: files }) })) as any
  it('exact file, unique quant, single gguf; loud on ambiguity and absence', async () => {
    const siblings = [{ rfilename: 'model-q4_k_m.gguf', size: 100 }, { rfilename: 'model-q8_0.gguf', size: 200 }, { rfilename: 'README.md' } as any]
    expect(await resolveHfFile({ kind: 'hf', repo: 'o/r', file: 'model-q8_0.gguf' }, api(siblings))).toEqual({ file: 'model-q8_0.gguf', size: 200 })
    expect(await resolveHfFile({ kind: 'hf', repo: 'o/r', quant: 'Q4_K_M' }, api(siblings))).toEqual({ file: 'model-q4_k_m.gguf', size: 100 })
    await expect(resolveHfFile({ kind: 'hf', repo: 'o/r' }, api(siblings))).rejects.toThrow(/2 GGUF files/)
    expect(await resolveHfFile({ kind: 'hf', repo: 'o/r' }, api([{ rfilename: 'only.gguf' }]))).toEqual({ file: 'only.gguf' })
    await expect(resolveHfFile({ kind: 'hf', repo: 'o/r', quant: 'NOPE' }, api(siblings))).rejects.toThrow(/no file matching/)
  })
})

describe('downloadModel + listModelStore', () => {
  it('streams to the store atomically with progress', async () => {
    const payload = Buffer.alloc(1024 * 64, 7)
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ siblings: [{ rfilename: 'm.gguf', size: payload.length }] })); return }
      res.writeHead(200, { 'content-length': String(payload.length) }); res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const dir = await mkdtemp(join(tmpdir(), 'llama-test-'))
    try {
      const progress: number[] = []
      // point the downloader at the local server by monkey-patching fetch for resolve + download
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (url: any, init?: any) => realFetch(String(url).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as any
      const out = await downloadModel(dir, { kind: 'hf', repo: 'o/r' }, { onProgress: (p) => progress.push(p.downloaded) })
      globalThis.fetch = realFetch
      expect(out.bytes).toBe(payload.length)
      expect(Buffer.compare(Buffer.from(await readFile(out.path)), payload)).toBe(0)
      expect(progress.length).toBeGreaterThan(0)
      const store = await listModelStore(dir)
      expect(store).toEqual([{ file: 'o_r--m.gguf', bytes: payload.length }])
      expect(out.path).toBe(modelStorePath(dir, 'o/r', 'm.gguf'))
    } finally {
      server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
