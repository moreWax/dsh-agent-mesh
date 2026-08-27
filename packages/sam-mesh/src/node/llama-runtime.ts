/**
 * Vendored llama.cpp runtime: the package CARRIES the inference engine.
 *
 * Platform packages (@morewax/llama-cpp-<os>-<arch>) ship the official
 * ggml-org/llama.cpp release tarball + manifest.json (tag, artifact sha256 —
 * committed at pack time; llama.cpp publishes no upstream checksums, so this
 * is TOFU-at-fetch, verified at every extract). The tarball is extracted
 * lazily into <dataDir>/vendor/, verified, and cached by content hash.
 *
 * Models are GBs and are NEVER vendored: HF refs (repo:quant or repo/file)
 * are resolved and downloaded into <dataDir>/models/ by explicit, consented
 * actions (the card or the CLI) — boot-time code only reads what exists.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Process-identity check: linux /proc first, ps fallback (mac). */
async function isLlamaServer(pid: number): Promise<boolean> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    return cmdline.includes('llama-server')
  } catch { /* not linux or gone */ }
  try {
    const out = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='])
    return out.stdout.includes('llama-server')
  } catch { return false }
}

const RUNTIME_PACKAGES: Record<string, string> = {
  'darwin-arm64': '@morewax/llama-cpp-darwin-arm64',
  'darwin-x64': '@morewax/llama-cpp-darwin-x64',
  'linux-x64': '@morewax/llama-cpp-linux-x64',
  'linux-arm64': '@morewax/llama-cpp-linux-arm64',
}

export interface VendoredLlama { binary: string; libDir: string; tag: string }

/** Resolve the vendored llama-server for this platform, extracting on first use. */
export async function resolveVendoredLlama(dataDir: string, options: { packageRoot?: string } = {}): Promise<VendoredLlama> {
  const key = `${process.platform}-${process.arch}`
  const pkgName = RUNTIME_PACKAGES[key]
  if (!pkgName) throw new Error(`no vendored llama.cpp runtime for ${key}`)
  let root = options.packageRoot
  if (!root) {
    try {
      const require = createRequire(import.meta.url)
      root = join(require.resolve(`${pkgName}/package.json`), '..')
    } catch {
      throw new Error(`platform package ${pkgName} is not installed (a package manager that skips optionalDependencies?) — install it or use an external backend target`)
    }
  }
  const manifest = JSON.parse(await readFile(join(root, 'bin', 'manifest.json'), 'utf8')) as { tag: string; artifact: string; artifactSha256: string }
  const payload = join(root, 'bin', manifest.artifact)
  const sha = createHash('sha256').update(await readFile(payload)).digest('hex')
  if (sha !== manifest.artifactSha256) throw new Error(`vendored llama.cpp payload failed integrity check (${payload}) — reinstall ${pkgName}`)
  const vendorDir = join(dataDir, 'vendor', `llama-${sha.slice(0, 12)}`)
  const binary = join(vendorDir, 'llama-server')
  if (!existsSync(binary)) {
    const tmp = `${vendorDir}.tmp-${process.pid}`
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    try {
      // macOS/Linux both ship tar; the tarball holds llama-server + shared libs side by side.
      await execFileAsync('tar', ['-xzf', payload, '-C', tmp])
      const entries = await execFileAsync('find', [tmp, '-name', 'llama-server', '-type', 'f'])
      const found = entries.stdout.trim().split('\n').filter(Boolean)[0]
      if (!found) throw new Error('llama-server not found in vendored tarball')
      const libDir = join(found, '..')
      for (const entry of await execFileAsync('ls', [libDir]).then(r => r.stdout.trim().split('\n'))) {
        await rename(join(libDir, entry), join(tmp, entry))
      }
      await chmod(join(tmp, 'llama-server'), 0o755)
      await rename(tmp, vendorDir)
    } catch (error) {
      await rm(tmp, { recursive: true, force: true })
      throw error
    }
  }
  return { binary, libDir: vendorDir, tag: manifest.tag }
}

export type ModelSpec = { kind: 'path'; path: string } | { kind: 'hf'; repo: string; quant?: string; file?: string }

/** 'repo:quant' | 'repo/file.gguf' | 'repo' | absolute-or-relative path. */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('empty model spec')
  if (trimmed.startsWith('/') || trimmed.startsWith('~/') || trimmed.endsWith('.gguf') && !trimmed.includes('/')) {
    if (trimmed.endsWith('.gguf') && !trimmed.includes('/')) return { kind: 'path', path: trimmed }
    if (trimmed.startsWith('/') || trimmed.startsWith('~/')) return { kind: 'path', path: trimmed }
  }
  const [repo, rest] = trimmed.split(':', 2)
  if (!repo?.includes('/')) throw new Error(`model spec must be a path, 'org/repo', 'org/repo:quant', or 'org/repo/file.gguf' — got: ${spec}`)
  if (rest !== undefined) return { kind: 'hf', repo, quant: rest }
  if (trimmed.endsWith('.gguf')) { const [r, f] = [repo.slice(0, repo.lastIndexOf('/')), repo.slice(repo.lastIndexOf('/') + 1)]; return { kind: 'hf', repo: r, file: f } }
  return { kind: 'hf', repo }
}

type HfFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Pick the GGUF file for a spec: exact file, else the filename containing the quant tag, else the only .gguf. */
export interface ResolvedHfFile { file: string; size?: number; sha256?: string }

export async function resolveHfFile(spec: ModelSpec & { kind: 'hf' }, fetchImpl: HfFetch = fetch as unknown as HfFetch): Promise<ResolvedHfFile> {
  const res = await fetchImpl(`https://huggingface.co/api/models/${spec.repo}`)
  if (!res.ok) throw new Error(`Hugging Face lookup failed for ${spec.repo} (${res.status})`)
  const body = await res.json() as { siblings?: Array<{ rfilename: string; size?: number; lfs?: { oid?: string } }> }
  const pick = (s: { rfilename: string; size?: number; lfs?: { oid?: string } }): ResolvedHfFile => ({ file: s.rfilename, ...(s.size !== undefined ? { size: s.size } : {}), ...(s.lfs?.oid ? { sha256: s.lfs.oid } : {}) })
  const ggufs = (body.siblings ?? []).filter(s => s.rfilename.endsWith('.gguf'))
  if (spec.file) {
    const exact = ggufs.find(s => s.rfilename === spec.file)
    if (!exact) throw new Error(`${spec.repo} has no ${spec.file} (available: ${ggufs.map(s => s.rfilename).join(', ') || 'none'})`)
    return pick(exact)
  }
  if (spec.quant) {
    const tagged = ggufs.filter(s => s.rfilename.toLowerCase().includes(spec.quant!.toLowerCase()))
    if (tagged.length === 1) return pick(tagged[0]!)
    if (tagged.length > 1) throw new Error(`quant '${spec.quant}' is ambiguous in ${spec.repo}: ${tagged.map(s => s.rfilename).join(', ')}`)
    throw new Error(`no file matching quant '${spec.quant}' in ${spec.repo} (available: ${ggufs.map(s => s.rfilename).join(', ') || 'none'})`)
  }
  if (ggufs.length === 1) return pick(ggufs[0]!)
  throw new Error(`${spec.repo} has ${ggufs.length} GGUF files — specify one: ${ggufs.map(s => s.rfilename).join(', ')}`)
}

export function modelStorePath(dataDir: string, repo: string, file: string): string {
  return join(dataDir, 'models', `${repo.replace(/[^\w.-]+/g, '_')}--${file.replace(/[^\w.-]+/g, '_')}`)
}

export interface DownloadProgress { downloaded: number; total?: number }

/** Stream an HF file into the model store (atomic tmp+rename). Resumable? No — v1 restarts cleanly. */
export async function downloadModel(dataDir: string, spec: ModelSpec & { kind: 'hf' }, options: { onProgress?: (p: DownloadProgress) => void; fetchImpl?: HfFetch; signal?: AbortSignal } = {}): Promise<{ path: string; file: string; bytes: number }> {
  const resolved = await resolveHfFile(spec, options.fetchImpl)
  const dest = modelStorePath(dataDir, spec.repo, resolved.file)
  const url = `https://huggingface.co/${spec.repo}/resolve/main/${resolved.file}`
  const res = await fetch(url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`)
  await mkdir(join(dest, '..'), { recursive: true })
  const tmp = `${dest}.part-${process.pid}`
  const total = Number(res.headers.get('content-length') ?? 0) || undefined
  let downloaded = 0
  const hash = createHash('sha256')
  const file = createWriteStream(tmp)
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      downloaded += value.length
      hash.update(value)
      file.write(value)
      options.onProgress?.({ downloaded, ...(total !== undefined ? { total } : {}) })
    }
    file.end()
    await new Promise<void>((resolve, reject) => { file.on('finish', () => resolve()); file.on('error', reject) })
    if (resolved.sha256 && hash.digest('hex') !== resolved.sha256) throw new Error(`integrity check failed for ${resolved.file} (Hugging Face lfs sha256 mismatch) — deleted; retry the pull`)
    await rename(tmp, dest)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
  return { path: dest, file: resolved.file, bytes: downloaded }
}

/** Where a spec's model file lives (or would live) on disk; null when a path spec points nowhere. */
export function modelPathFor(dataDir: string, spec: ModelSpec): string | null {
  if (spec.kind === 'path') {
    const path = spec.path.startsWith('~/') ? join(process.env.HOME ?? '~', spec.path.slice(2)) : spec.path
    return existsSync(path) ? path : null
  }
  return null
}

export interface RuntimeStartOptions {
  modelPath: string
  alias: string
  port: number
  /** For the orphan-adoption pidfile (default ~/.config/sam-mesh). */
  dataDir?: string
  contextSize?: number
  gpuLayers?: number
  extraArgs?: string[]
  onLog?: (line: string) => void
}

export interface RuntimeStatus { running: boolean; pid?: number | undefined; model?: string | undefined; port?: number | undefined; uptimeMs?: number | undefined }

/** One llama-server child. Loopback-only; the gate proxy is the only inbound path. */
export class LlamaRuntime {
  #child: ChildProcess | undefined
  #startedAt = 0
  constructor(private readonly vendored: VendoredLlama, private readonly options: RuntimeStartOptions) {}

  async start(readyTimeoutMs = 120_000): Promise<void> {
    if (this.#child) return
    if (!await this.#portFree()) {
      // A stale pidfile + a live llama-server on this port = orphaned child of a
      // crashed dsh. Adopt: terminate it and take the port back.
      if (await this.#reclaimOrphan()) {
        // reclaimed
      } else throw new Error(`port ${this.options.port} is already in use by a non-llama process — pick another runtime port`)
    }
    const args = [
      '--model', this.options.modelPath,
      '--alias', this.options.alias,
      '--host', '127.0.0.1',
      '--port', String(this.options.port),
      '--ctx-size', String(this.options.contextSize ?? 4096),
      '--gpu-layers', String(this.options.gpuLayers ?? 99),
      ...(this.options.extraArgs ?? []),
    ]
    const env = { ...process.env, LD_LIBRARY_PATH: this.vendored.libDir, DYLD_LIBRARY_PATH: this.vendored.libDir }
    const child = spawn(this.vendored.binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.#child = child
    const log = this.options.onLog ?? (() => {})
    child.stdout?.on('data', (d: Buffer) => log(d.toString().trim()))
    child.stderr?.on('data', (d: Buffer) => log(d.toString().trim()))
    child.on('exit', () => { this.#child = undefined })
    this.#startedAt = Date.now()
    await mkdir(join(this.#pidfile(), '..'), { recursive: true })
    await writeFile(this.#pidfile(), JSON.stringify({ pid: child.pid, model: this.options.modelPath, port: this.options.port, startedAt: new Date(this.#startedAt).toISOString() }))
    const deadline = Date.now() + readyTimeoutMs
    for (;;) {
      if (!this.#child) throw new Error('llama-server exited during startup — check the model file and runtime logs')
      try {
        const res = await fetch(`http://127.0.0.1:${this.options.port}/health`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) return
      } catch { /* not ready */ }
      if (Date.now() > deadline) { await this.stop(); throw new Error(`llama-server did not become healthy within ${readyTimeoutMs}ms`) }
      await new Promise(r => setTimeout(r, 500))
    }
  }

  async #portFree(): Promise<boolean> {
    return import('node:net').then(({ createServer }) => new Promise<boolean>((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.listen(this.options.port, '127.0.0.1', () => s.close(() => resolve(true)))
    }))
  }

  /** Kill a stale llama-server holding our port (pidfile + process identity check). */
  async #reclaimOrphan(): Promise<boolean> {
    const pidfile = this.#pidfile()
    let pid: number
    try { pid = JSON.parse(await readFile(pidfile, 'utf8')).pid } catch { return false }
    if (!Number.isInteger(pid)) return false
    try { process.kill(pid, 0) } catch { return false }
    if (!await isLlamaServer(pid)) return false
    this.options.onLog?.(`reclaiming port ${this.options.port} from orphaned llama-server (pid ${pid})`)
    try { process.kill(pid, 'SIGTERM') } catch { return false }
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { return true }
      await new Promise(r => setTimeout(r, 200))
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    await new Promise(r => setTimeout(r, 300))
    return this.#portFree()
  }

  #pidfile(): string { return join(this.options.dataDir ?? join(process.env.HOME ?? '', '.config', 'sam-mesh'), 'runtime', `llama-${this.options.port}.json`) }

  status(): RuntimeStatus {
    return this.#child
      ? { running: true, pid: this.#child.pid, model: this.options.alias, port: this.options.port, uptimeMs: Date.now() - this.#startedAt }
      : { running: false }
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (!child) return
    this.#child = undefined
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/** Files already in the model store (for the card's status). */
export async function listModelStore(dataDir: string): Promise<Array<{ file: string; bytes: number }>> {
  const dir = join(dataDir, 'models')
  if (!existsSync(dir)) return []
  const { readdir } = await import('node:fs/promises')
  const out: Array<{ file: string; bytes: number }> = []
  for (const name of await readdir(dir)) {
    if (name.includes('.part-')) continue
    const info = await stat(join(dir, name)).catch(() => undefined)
    if (info?.isFile()) out.push({ file: name, bytes: info.size })
  }
  return out
}
