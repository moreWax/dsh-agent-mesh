import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { ClusterRuntime, DeploymentBundle, RuntimeCheck, RuntimeDetection, RuntimeLogOptions, RuntimeStatus } from './interface.js'
import { RuntimeError } from './errors.js'
import { ArtifactInstaller, loadArtifactManifest, runtimePlatform, type ArtifactManifest } from './artifacts.js'
import { detectRootlessCapabilities } from './capabilities.js'
import { runCommand, type CommandRunner } from './command.js'
import { UserProcessManager } from './process.js'
import { SystemdUserManager } from './systemd-user.js'

export interface RootlessK3sOptions { baseDir?: string; manifestPath?: string; runner?: CommandRunner; processManager?: UserProcessManager; systemdManager?: SystemdUserManager; lifecycle?: 'auto' | 'systemd-user' | 'direct'; platform?: NodeJS.Platform; arch?: string }

export class RootlessK3sRuntime implements ClusterRuntime {
  readonly kind = 'rootless-k3s' as const
  private readonly runner: CommandRunner
  private readonly binDir: string; private readonly downloadsDir: string; private readonly dataDir: string; private readonly logDir: string; private readonly kubeconfig: string
  private manager: UserProcessManager | undefined
  private systemd: SystemdUserManager | undefined
  private lifecycle: 'systemd-user' | 'direct' = 'direct'
  constructor(private readonly options: RootlessK3sOptions = {}) {
    const baseDir = options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage')
    this.runner = options.runner ?? runCommand; this.binDir = join(baseDir, 'runtime/bin'); this.downloadsDir = join(baseDir, 'runtime/downloads'); this.dataDir = join(baseDir, 'k3s/data'); this.logDir = join(baseDir, 'k3s/logs'); this.kubeconfig = join(baseDir, 'k3s/kubeconfig.yaml'); this.manager = options.processManager; this.systemd = options.systemdManager
  }
  private executable(name: string): string { return join(this.binDir, name) }
  private async manifest(): Promise<ArtifactManifest> { return await loadArtifactManifest(this.options.manifestPath ?? new URL('../assets/runtime/artifacts.json', import.meta.url).pathname) }
  private async installedChecks(): Promise<RuntimeCheck[]> { const checks: RuntimeCheck[] = []; for (const name of ['k3s', 'rootlesskit', 'slirp4netns']) { try { await access(this.executable(name), constants.X_OK); checks.push({ name: `binary:${name}`, ok: true, required: true, detail: 'installed' }) } catch { checks.push({ name: `binary:${name}`, ok: false, required: true, detail: 'missing', fix: 'Install the verified rootless runtime bundle' }) } }; return checks }
  async detect(_signal?: AbortSignal): Promise<RuntimeDetection> { const checks = [...await detectRootlessCapabilities({ homeDir: this.options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage') }), ...await this.installedChecks()]; return { kind: this.kind, available: checks.every(check => !check.required || check.ok), checks } }
  async prepare(signal?: AbortSignal): Promise<void> {
    const capabilities = await detectRootlessCapabilities({ homeDir: this.options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage') }); if (capabilities.some(c => c.required && !c.ok)) throw new RuntimeError('IMESSAGE_RUNTIME_UNSUPPORTED', 'This host does not meet rootless k3s requirements', 'Resolve failed capability checks or choose another runtime', false)
    const platform = runtimePlatform(this.options.platform ?? process.platform, (this.options.arch ?? process.arch) as NodeJS.Architecture); const artifacts = (await this.manifest()).artifacts[platform]; const installer = new ArtifactInstaller({ downloadsDir: this.downloadsDir, binDir: this.binDir }, undefined, this.runner)
    for (const artifact of artifacts) await installer.install(artifact, signal)
  }
  private processManager(): UserProcessManager {
    if (this.manager) return this.manager
    const env = { ...process.env, PATH: `${this.binDir}:${process.env.PATH ?? ''}`, K3S_DATA_DIR: this.dataDir, K3S_KUBECONFIG_OUTPUT: this.kubeconfig, K3S_KUBECONFIG_MODE: '600' }
    this.manager = new UserProcessManager({ command: this.executable('k3s'), args: ['server', '--rootless', '--snapshotter=native', '--disable=traefik', '--data-dir', this.dataDir, '--write-kubeconfig', this.kubeconfig, '--write-kubeconfig-mode', '600'], env, cwd: this.options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage'), stateDir: join(this.options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage'), 'k3s'), logDir: this.logDir })
    return this.manager
  }
  private systemdManager(): SystemdUserManager {
    if (this.systemd) return this.systemd
    const baseDir = this.options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage')
    const env = { PATH: `${this.binDir}:${process.env.PATH ?? ''}`, K3S_DATA_DIR: this.dataDir, K3S_KUBECONFIG_OUTPUT: this.kubeconfig, K3S_KUBECONFIG_MODE: '600' }
    this.systemd = new SystemdUserManager({ unitName: 'dsh-imessage-k3s.service', unitPath: join(process.env.HOME ?? '.', '.config/systemd/user/dsh-imessage-k3s.service'), executable: this.executable('k3s'), args: ['server', '--rootless', '--snapshotter=native', '--disable=traefik', '--data-dir', this.dataDir, '--write-kubeconfig', this.kubeconfig, '--write-kubeconfig-mode', '600'], environment: env, workingDirectory: baseDir })
    return this.systemd
  }
  private async startManaged(signal?: AbortSignal): Promise<void> {
    const preference = this.options.lifecycle ?? 'auto'
    const systemd = this.systemdManager()
    if (preference !== 'direct' && await systemd.available(signal)) { await systemd.start(signal); this.lifecycle = 'systemd-user'; return }
    if (preference === 'systemd-user') throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'The user systemd session is unavailable', 'Enable the user systemd session or select direct lifecycle mode', false)
    await this.processManager().start(); this.lifecycle = 'direct'
  }
  async start(signal?: AbortSignal): Promise<void> {
    const detected = await this.detect(signal)
    if (!detected.available) throw new RuntimeError('IMESSAGE_RUNTIME_NOT_CONFIGURED', 'Rootless runtime binaries or host capabilities are missing', 'Run the explicit rootless runtime prepare step', false)
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await this.startManaged(signal)
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (signal?.aborted) throw signal.reason
        try { await this.command(['get', 'nodes'], signal); return } catch { await new Promise(resolve => setTimeout(resolve, 1000)) }
      }
      throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'Rootless k3s did not become ready', 'Inspect the private k3s log and retry', true)
    } catch (error) { await this.stop().catch(() => undefined); throw error }
  }
  private async command(args: string[], signal?: AbortSignal, input?: string): Promise<string> { try { return (await this.runner({ command: this.executable('k3s'), args: ['kubectl', ...args], env: { ...process.env, KUBECONFIG: this.kubeconfig }, timeoutMs: 20_000, ...(signal ? { signal } : {}), ...(input === undefined ? {} : { input }) })).stdout } catch (cause) { throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'Rootless Kubernetes API operation failed', 'Check rootless k3s status and private logs', true, { cause }) } }
  async status(signal?: AbortSignal): Promise<RuntimeStatus> { const detection = await this.detect(signal); const running = detection.available && (this.lifecycle === 'systemd-user' ? await this.systemdManager().running(signal) : await this.processManager().running()); const api = running ? await this.command(['get', 'nodes', '-o', 'name'], signal).then(() => true, () => false) : false; const checks = [...detection.checks, { name: 'process', ok: running, required: true, detail: running ? 'running' : 'stopped' }, { name: 'api', ok: api, required: true, detail: api ? 'ready' : 'unavailable' }]; return { kind: this.kind, health: api ? 'ready' : detection.available ? 'degraded' : 'not-configured', detail: api ? 'Rootless k3s is ready' : 'Rootless k3s needs attention', checks, lastCheckedAt: new Date().toISOString() } }
  async apply(bundle: DeploymentBundle, signal?: AbortSignal): Promise<void> { if (!bundle.manifestPaths.length) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Deployment bundle has no manifests', undefined, false); const namespace = await this.command(['create', 'namespace', bundle.namespace, '--dry-run=client', '-o', 'yaml'], signal); await this.command(['apply', '-f', '-'], signal, namespace); for (const path of bundle.manifestPaths) await this.command(['apply', '-n', bundle.namespace, '-f', path], signal) }
  async stop(signal?: AbortSignal): Promise<void> { if (this.lifecycle === 'systemd-user') await this.systemd?.stop(signal); else await this.manager?.stop() }
  async remove(signal?: AbortSignal): Promise<void> { await this.stop(signal); await this.systemd?.remove(signal); await rm(join(this.options.baseDir ?? join(process.env.HOME ?? '.', '.local/share/dsh-imessage'), 'k3s'), { recursive: true, force: true }) }
  async *logs(options: RuntimeLogOptions): AsyncIterable<string> { try { const content = await readFile(join(this.logDir, 'k3s.log'), 'utf8'); for (const line of content.split(/\r?\n/).slice(-(options.tail ?? 200))) if (line) yield line.slice(0, 4096) } catch { throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'Rootless k3s log is unavailable', undefined, true) } }
}
