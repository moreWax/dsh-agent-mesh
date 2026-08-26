/**
 * Bundled sam-node resolution: the npm package CARRIES the binary.
 *
 * Platform packages (@morewax/sam-node-<os>-<arch>) ship sam-node.gz +
 * manifest.json (release tag, artifact sha256, binary sha256) — official
 * google/sam release artifacts, checksum-verified at pack time. Nothing is
 * downloaded at install or runtime; the gzipped binary is extracted lazily
 * on first use into <dataDir>/vendor/, verified against the manifest, and
 * cached by content hash so upgrades re-extract cleanly.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'

const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': '@morewax/sam-node-darwin-arm64',
  'darwin-x64': '@morewax/sam-node-darwin-x64',
  'linux-x64': '@morewax/sam-node-linux-x64',
  'linux-arm64': '@morewax/sam-node-linux-arm64',
}

export interface BundledBinary { path: string; tag: string; binarySha256: string }

/**
 * Resolve the bundled binary for this platform, extracting on first use.
 * Returns null on unsupported platforms or when the platform package is not
 * installed (e.g. a package manager that skips optionalDependencies) — the
 * caller falls back to PATH.
 */
export async function resolveBundledBinary(dataDir: string, options: { packageRoot?: string } = {}): Promise<BundledBinary | null> {
  const key = `${process.platform}-${process.arch}`
  const pkgName = PLATFORM_PACKAGES[key]
  if (!pkgName) return null
  let root = options.packageRoot
  if (!root) {
    try {
      const require = createRequire(import.meta.url)
      root = join(require.resolve(`${pkgName}/package.json`), '..')
    } catch { return null }
  }
  let manifest: { tag: string; binarySha256: string }
  let compressed: Buffer
  try {
    manifest = JSON.parse(await readFile(join(root, 'bin', 'manifest.json'), 'utf8'))
    compressed = await readFile(join(root, 'bin', 'sam-node.gz'))
  } catch { return null }

  const vendorDir = join(dataDir, 'vendor')
  const target = join(vendorDir, `sam-node-${manifest.binarySha256.slice(0, 12)}`)
  try {
    await readFile(target)
    return { path: target, tag: manifest.tag, binarySha256: manifest.binarySha256 } // cache hit
  } catch { /* extract */ }

  const binary = gunzipSync(compressed)
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== manifest.binarySha256) {
    throw new Error(`bundled sam-node failed integrity check: sha256 ${actual.slice(0, 12)}… != manifest ${manifest.binarySha256.slice(0, 12)}… (package may be corrupted — reinstall)`)
  }
  await mkdir(vendorDir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, binary, { mode: 0o755 })
  await chmod(tmp, 0o755)
  await rename(tmp, target)
  return { path: target, tag: manifest.tag, binarySha256: manifest.binarySha256 }
}
