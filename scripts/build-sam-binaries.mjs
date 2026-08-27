#!/usr/bin/env node
/**
 * Pack-time sam-node BUILD: compiles sam-node from a PINNED google/sam
 * commit for every platform package, and gzips it with a manifest.
 *
 * Why a build (not the official release tarballs): every release ≤
 * v0.1.0-alpha.7 cannot complete OIDC device-flow enrollment against dex
 * (token poll only accepts HTTP 400; dex answers pending with 401 — fatal
 * on the first poll). The upstream fix (994d082a) is in no release. We pin
 * the first commit that carries it and build reproducibly: CGO_ENABLED=0,
 * -trimpath, pinned source tarball by immutable commit sha.
 * Switch back to scripts/fetch-sam-binaries.mjs once upstream tags a
 * release containing the fix.
 *
 * Requires: go (>= 1.22) on PATH. Nothing is downloaded at install or
 * runtime; this runs at pack/publish time (or in CI).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The pinned upstream commit: first HEAD known to carry the dex-401 device-flow fix. */
const COMMIT = '650232312ce46d193c231ccaa2324bf861b12482'
const COMMIT_DATE = '2026-08-25'
const REPO = 'https://github.com/google/sam'
const ROOT = new URL('..', import.meta.url).pathname

const PLATFORMS = {
  'sam-node-darwin-arm64': { goos: 'darwin', goarch: 'arm64' },
  'sam-node-darwin-x64': { goos: 'darwin', goarch: 'amd64' },
  'sam-node-linux-x64': { goos: 'linux', goarch: 'amd64' },
  'sam-node-linux-arm64': { goos: 'linux', goarch: 'arm64' },
}

try {
  execFileSync('go', ['version'], { stdio: 'pipe' })
} catch {
  console.error('go is required on PATH (>= 1.22) — install Go or run this in CI (setup-go).')
  process.exit(1)
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

// 1. pinned source tarball (immutable commit — integrity by pinning)
const srcTar = join(tmpdir(), `sam-src-${COMMIT.slice(0, 12)}.tar.gz`)
if (!existsSync(srcTar)) {
  console.log(`download source ${COMMIT.slice(0, 12)}`)
  await download(`${REPO}/archive/${COMMIT}.tar.gz`, srcTar)
}
const srcDir = join(tmpdir(), `sam-src-${COMMIT.slice(0, 12)}`)
await rm(srcDir, { recursive: true, force: true })
mkdirSync(srcDir, { recursive: true })
execFileSync('tar', ['-xzf', srcTar, '-C', srcDir, '--strip-components=1'])

// 2. cross-build every platform (Go cross-compiles; CGO off = static)
for (const [pkg, { goos, goarch }] of Object.entries(PLATFORMS)) {
  const out = join(tmpdir(), `sam-node-${goos}-${goarch}`)
  console.log(`build ${goos}/${goarch}`)
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, './cmd/sam-node'], {
    cwd: srcDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    stdio: 'inherit',
  })
  const binary = readFileSync(out)
  const outDir = join(ROOT, 'packages', pkg, 'bin')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'sam-node.gz'), gzipSync(binary, { level: 9 }))
  const manifest = {
    source: 'ci-build',
    tag: `ci-${COMMIT.slice(0, 7)}`,
    commit: COMMIT,
    commitDate: COMMIT_DATE,
    reason: 'releases ≤ v0.1.0-alpha.7 cannot poll dex device flow (fix 994d082a untagged)',
    builder: 'scripts/build-sam-binaries.mjs (CGO_ENABLED=0 go build -trimpath -ldflags="-s -w")',
    binarySha256: createHash('sha256').update(binary).digest('hex'),
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`  ${pkg}: sha256 ${manifest.binarySha256.slice(0, 16)}…`)
}
console.log('done — binaries are staged for packing; commit the manifests, keep bin/*.gz gitignored until publish')
