#!/usr/bin/env node
/**
 * Pack-time llama.cpp fetch: downloads the OFFICIAL ggml-org/llama.cpp
 * release tarballs for every supported platform, records their sha256 in
 * each @morewax/llama-cpp-<platform> package's manifest (committed —
 * llama.cpp publishes no upstream checksums, so integrity is TOFU at fetch
 * time, verified at every runtime extract), and stores the tarball as the
 * vendored payload. Nothing is downloaded at install or runtime.
 *
 *   node scripts/fetch-llama-binaries.mjs
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = 'b10642'
const REPO = 'https://github.com/ggml-org/llama.cpp'
const ROOT = new URL('..', import.meta.url).pathname
const VERSION = `0.${TAG.slice(1)}.0`

const PLATFORMS = {
  'llama-cpp-darwin-arm64': { artifact: `llama-${TAG}-bin-macos-arm64.tar.gz`, os: 'darwin', cpu: 'arm64' },
  'llama-cpp-darwin-x64': { artifact: `llama-${TAG}-bin-macos-x64.tar.gz`, os: 'darwin', cpu: 'x64' },
  'llama-cpp-linux-x64': { artifact: `llama-${TAG}-bin-ubuntu-x64.tar.gz`, os: 'linux', cpu: 'x64' },
  'llama-cpp-linux-arm64': { artifact: `llama-${TAG}-bin-ubuntu-arm64.tar.gz`, os: 'linux', cpu: 'arm64' },
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

for (const [pkg, { artifact }] of Object.entries(PLATFORMS)) {
  const url = `${REPO}/releases/download/${TAG}/${artifact}`
  const tarPath = join(tmpdir(), artifact)
  if (!existsSync(tarPath)) { console.log(`download ${artifact}`); await download(url, tarPath) }
  const hash = sha256(tarPath)
  const dir = join(ROOT, 'packages', pkg)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  copyFileSync(tarPath, join(dir, 'bin', artifact))
  writeFileSync(join(dir, 'bin', 'manifest.json'), JSON.stringify({ tag: TAG, artifact, artifactSha256: hash }, null, 2) + '\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@morewax/${pkg}`,
    version: VERSION,
    description: `Vendored llama.cpp ${TAG} runtime (${pkg.replace('llama-cpp-', '')}) for @morewax/sam-mesh`,
    license: 'MIT',
    os: [PLATFORMS[pkg].os],
    cpu: [PLATFORMS[pkg].cpu],
    publishConfig: { access: 'public' },
    files: ['bin'],
  }, null, 2) + '\n')
  console.log(`${pkg}: ${artifact} sha256=${hash.slice(0, 12)}…`)
}
console.log(`done — runtime ${TAG} vendored as version ${VERSION}`)
