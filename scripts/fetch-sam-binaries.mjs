#!/usr/bin/env node
/**
 * Pack-time binary fetch: downloads the OFFICIAL google/sam release
 * tarballs, verifies them against the release's own checksums.txt, extracts
 * sam-node, and gzips it into each @morewax/sam-node-<platform> package.
 *
 * Doctrine: binaries are vendored at PACK time with provenance (pinned tag
 * + sha256), never downloaded at install time. Run before npm publish:
 *   node scripts/fetch-sam-binaries.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = 'v0.1.0-alpha.7'
const REPO = 'https://github.com/google/sam'
const ROOT = new URL('..', import.meta.url).pathname

const PLATFORMS = {
  'sam-node-darwin-arm64': 'sam_Darwin_arm64.tar.gz',
  'sam-node-darwin-x64': 'sam_Darwin_x86_64.tar.gz',
  'sam-node-linux-x64': 'sam_Linux_x86_64.tar.gz',
  'sam-node-linux-arm64': 'sam_Linux_arm64.tar.gz',
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const file = createWriteStream(dest)
  await new Promise((resolve, reject) => {
    res.body.pipeTo(new WritableStream({ write: (c) => file.write(c), close: resolve, error: reject })).catch(reject)
    file.on('error', reject)
  })
  file.end()
  await new Promise((r) => file.on('finish', r))
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// 1. checksums manifest from the release itself
const sumsUrl = `${REPO}/releases/download/${TAG}/sam_0.1.0-alpha.7_checksums.txt`
const sumsPath = join(tmpdir(), 'sam-checksums.txt')
await download(sumsUrl, sumsPath)
const sums = new Map(
  readFileSync(sumsPath, 'utf8').trim().split('\n').map((line) => {
    const [hash, name] = line.trim().split(/\s+/)
    return [name, hash]
  }),
)
console.log(`checksums for ${TAG}: ${sums.size} artifacts`)

for (const [pkg, tar] of Object.entries(PLATFORMS)) {
  const expected = sums.get(tar)
  if (!expected) throw new Error(`no checksum for ${tar}`)
  const tarPath = join(tmpdir(), tar)
  if (!existsSync(tarPath) || sha256(tarPath) !== expected) {
    console.log(`download ${tar}`)
    await download(`${REPO}/releases/download/${TAG}/${tar}`, tarPath)
  }
  const actual = sha256(tarPath)
  if (actual !== expected) throw new Error(`CHECKSUM MISMATCH ${tar}: got ${actual}, want ${expected}`)
  // extract sam-node only
  const work = join(tmpdir(), `sam-extract-${pkg}`)
  await rm(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  execFileSync('tar', ['-xzf', tarPath, '-C', work, 'sam-node'])
  const binary = readFileSync(join(work, 'sam-node'))
  const outDir = join(ROOT, 'packages', pkg, 'bin')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'sam-node.gz')
  writeFileSync(out, gzipSync(binary, { level: 9 }))
  const manifest = { tag: TAG, artifact: tar, artifactSha256: expected, binarySha256: createHash('sha256').update(binary).digest('hex') }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${pkg}: bin/sam-node.gz ${(binary.length / 1048576).toFixed(1)}MB -> ${(readFileSync(out).length / 1048576).toFixed(1)}MB (sha ${manifest.binarySha256.slice(0, 12)}…)`)
}
console.log('done — vendored binaries are ready for publish')
