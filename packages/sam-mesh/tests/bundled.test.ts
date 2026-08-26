import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBundledBinary } from '../src/node/bundled.js'

let dir: string
let pkgRoot: string
const FAKE_BINARY = Buffer.from('#!/bin/sh\necho fake sam-node\n')

async function makePackage(binary: Buffer, tamper = false): Promise<void> {
  const sha = createHash('sha256').update(binary).digest('hex')
  await mkdir(join(pkgRoot, 'bin'), { recursive: true })
  await writeFile(join(pkgRoot, 'bin', 'sam-node.gz'), gzipSync(binary))
  await writeFile(join(pkgRoot, 'bin', 'manifest.json'), JSON.stringify({
    tag: 'v0.1.0-alpha.7', artifact: 'sam_Test_x64.tar.gz', artifactSha256: 'a'.repeat(64),
    binarySha256: tamper ? 'b'.repeat(64) : sha,
  }))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bundled-'))
  pkgRoot = await mkdtemp(join(tmpdir(), 'bundled-pkg-'))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(pkgRoot, { recursive: true, force: true }) })

describe('resolveBundledBinary', () => {
  it('extracts, verifies, chmods, and caches by content hash', async () => {
    await makePackage(FAKE_BINARY)
    const first = await resolveBundledBinary(dir, { packageRoot: pkgRoot })
    expect(first).not.toBeNull()
    expect(first!.tag).toBe('v0.1.0-alpha.7')
    const content = await readFile(first!.path)
    expect(content.equals(FAKE_BINARY)).toBe(true)
    expect(first!.path).toContain('vendor')
    // executable
    const stat = execFileSync('stat', ['-c', '%a', first!.path], { encoding: 'utf8' }).trim()
    expect(stat).toBe('755')
    // second resolve is a cache hit at the same path
    const second = await resolveBundledBinary(dir, { packageRoot: pkgRoot })
    expect(second!.path).toBe(first!.path)
  })

  it('refuses a binary whose hash does not match the manifest', async () => {
    await makePackage(FAKE_BINARY, true)
    await expect(resolveBundledBinary(dir, { packageRoot: pkgRoot })).rejects.toThrow(/integrity check/)
  })

  it('returns null when the platform package is absent (caller falls back to PATH)', async () => {
    expect(await resolveBundledBinary(dir, { packageRoot: join(pkgRoot, 'missing') })).toBeNull()
  })
})
