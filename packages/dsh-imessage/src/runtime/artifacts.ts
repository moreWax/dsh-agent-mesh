import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { runCommand, type CommandRunner } from './command.js'
import { RuntimeError } from './errors.js'

export type RuntimePlatform = 'linux-x64' | 'linux-arm64'
export interface Artifact { name: 'k3s' | 'rootlesskit' | 'slirp4netns'; version: string; url: string; sha256: string; format: 'file' | 'tar.gz'; executables: string[] }
export interface ArtifactManifest { schemaVersion: 1; artifacts: Record<RuntimePlatform, Artifact[]> }
export interface ArtifactInstallResult { name: string; version: string; executables: string[]; sha256: string }
export type ArtifactFetcher = (url: string, destination: string, signal?: AbortSignal) => Promise<void>

export function runtimePlatform(platform = process.platform, arch = process.arch): RuntimePlatform {
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) throw new RuntimeError('IMESSAGE_RUNTIME_UNSUPPORTED', `Rootless k3s does not support ${platform}-${arch}`, 'Use Linux x64/arm64, an existing cluster, or external Matrix', false)
  return `linux-${arch}`
}

export async function loadArtifactManifest(path: string): Promise<ArtifactManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as ArtifactManifest
  if (value.schemaVersion !== 1 || !value.artifacts || typeof value.artifacts !== 'object') throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Invalid runtime artifact manifest', undefined, false)
  for (const artifacts of Object.values(value.artifacts)) for (const artifact of artifacts) {
    if (!/^https:\/\//.test(artifact.url) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.executables.some(name => name !== basename(name))) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Unsafe runtime artifact declaration', undefined, false)
  }
  return value
}

export const fetchArtifact: ArtifactFetcher = async (url, destination, signal) => {
  let response: Response
  try { response = await fetch(url, { redirect: 'follow', ...(signal ? { signal } : {}) }) } catch (cause) { throw new RuntimeError('IMESSAGE_RUNTIME_TRANSIENT', 'Runtime artifact download failed', 'Check network connectivity and retry', true, { cause }) }
  if (!response.ok || !response.body) throw new RuntimeError('IMESSAGE_RUNTIME_TRANSIENT', `Runtime artifact download returned HTTP ${response.status}`, 'Retry later or use an existing cluster', response.status >= 500)
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
}

export async function sha256(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }

export class ArtifactInstaller {
  constructor(private readonly paths: { downloadsDir: string; binDir: string }, private readonly fetcher: ArtifactFetcher = fetchArtifact, private readonly runner: CommandRunner = runCommand) {}

  async install(artifact: Artifact, signal?: AbortSignal): Promise<ArtifactInstallResult> {
    await mkdir(this.paths.downloadsDir, { recursive: true, mode: 0o700 }); await mkdir(this.paths.binDir, { recursive: true, mode: 0o700 })
    const partial = join(this.paths.downloadsDir, `${artifact.name}-${artifact.version}.${randomUUID()}.partial`)
    const staging = join(this.paths.downloadsDir, `${artifact.name}-${randomUUID()}.staging`)
    try {
      await this.fetcher(artifact.url, partial, signal)
      const actual = await sha256(partial)
      if (actual !== artifact.sha256) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', `Checksum verification failed for ${artifact.name}`, 'Delete the partial download and retry; do not run the artifact', false)
      await mkdir(staging, { mode: 0o700 })
      if (artifact.format === 'file') await copyFile(partial, join(staging, artifact.executables[0]!))
      else {
        // Listing and exact member extraction prevent absolute paths and traversal.
        const listing = await this.runner({ command: 'tar', args: ['-tzf', partial], timeoutMs: 15_000, ...(signal ? { signal } : {}) })
        const members = listing.stdout.split(/\r?\n/).filter(Boolean)
        if (members.some(member => member.startsWith('/') || member.split('/').includes('..')) || artifact.executables.some(name => !members.includes(name))) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', `Unsafe archive content for ${artifact.name}`, undefined, false)
        await this.runner({ command: 'tar', args: ['-xzf', partial, '-C', staging, '--no-same-owner', '--no-same-permissions', '--', ...artifact.executables], timeoutMs: 30_000, ...(signal ? { signal } : {}) })
      }
      const installed: string[] = []
      for (const name of artifact.executables) {
        const source = join(staging, name)
        const sourceInfo = await lstat(source)
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', `Unsafe executable type in ${artifact.name}`, undefined, false)
        const target = join(this.paths.binDir, name); const temporary = `${target}.${randomUUID()}.new`
        await copyFile(source, temporary); await chmod(temporary, 0o700); const handle = await open(temporary, 'r'); try { await handle.sync() } finally { await handle.close() }; await rename(temporary, target); installed.push(target)
      }
      const directory = await open(dirname(join(this.paths.binDir, 'x')), 'r'); try { await directory.sync() } finally { await directory.close() }
      return { name: artifact.name, version: artifact.version, executables: installed, sha256: actual }
    } finally { await rm(partial, { force: true }); await rm(staging, { recursive: true, force: true }) }
  }
}
