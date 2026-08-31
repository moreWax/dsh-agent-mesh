import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { ClusterRuntime, DeploymentBundle, RuntimeCheck, RuntimeDetection, RuntimeLogOptions, RuntimeStatus } from './interface.js'
import { RuntimeError, safeRuntimeDetail } from './errors.js'
import { runCommand, type CommandRunner } from './command.js'

export interface ExistingKubernetesOptions { kubeconfig: string; namespace?: string; kubectl?: string; runner?: CommandRunner }

export class ExistingKubernetesRuntime implements ClusterRuntime {
  readonly kind = 'existing-kubernetes' as const
  private readonly runner: CommandRunner
  private readonly kubectl: string
  private readonly namespace: string
  constructor(private readonly options: ExistingKubernetesOptions) {
    this.runner = options.runner ?? runCommand; this.kubectl = options.kubectl ?? 'kubectl'; this.namespace = options.namespace ?? 'dsh-imessage'
  }
  private env(): NodeJS.ProcessEnv { return { ...process.env, KUBECONFIG: this.options.kubeconfig } }
  private async command(args: string[], signal?: AbortSignal, input?: string): Promise<string> {
    try { return (await this.runner({ command: this.kubectl, args, env: this.env(), timeoutMs: 20_000, ...(signal ? { signal } : {}), ...(input === undefined ? {} : { input }) })).stdout }
    catch (cause) { throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', safeRuntimeDetail(cause), 'Check kubeconfig, cluster reachability, and kubectl availability', true, { cause }) }
  }
  private async canI(resource: string, verb: string, signal?: AbortSignal): Promise<RuntimeCheck> {
    try { const value = (await this.command(['auth', 'can-i', verb, resource, '--namespace', this.namespace], signal)).trim() === 'yes'; return { name: `${verb}:${resource}`, ok: value, required: true, detail: value ? 'allowed' : 'denied', ...(value ? {} : { fix: `Grant ${verb} on ${resource} in namespace ${this.namespace}` }) } }
    catch { return { name: `${verb}:${resource}`, ok: false, required: true, detail: 'check failed', fix: 'Verify Kubernetes API access and RBAC' } }
  }
  async detect(signal?: AbortSignal): Promise<RuntimeDetection> {
    const checks: RuntimeCheck[] = []
    try { await access(this.options.kubeconfig, constants.R_OK); checks.push({ name: 'kubeconfig', ok: true, required: true, detail: 'readable' }) }
    catch { checks.push({ name: 'kubeconfig', ok: false, required: true, detail: 'not readable', fix: 'Select a readable kubeconfig owned by this user' }); return { kind: this.kind, available: false, checks } }
    try { await this.command(['version', '--request-timeout=5s', '-o', 'json'], signal); checks.push({ name: 'api', ok: true, required: true, detail: 'reachable' }) }
    catch { checks.push({ name: 'api', ok: false, required: true, detail: 'unreachable', fix: 'Check cluster endpoint, client certificate, and network access' }); return { kind: this.kind, available: false, checks } }
    for (const [resource, verb] of [['namespaces', 'create'], ['deployments.apps', 'create'], ['statefulsets.apps', 'create'], ['secrets', 'create'], ['configmaps', 'create'], ['persistentvolumeclaims', 'create']] as const) checks.push(await this.canI(resource, verb, signal))
    try { const parsed = JSON.parse(await this.command(['get', 'storageclass', '-o', 'json'], signal)) as { items?: unknown[] }; const ok = (parsed.items?.length ?? 0) > 0; checks.push({ name: 'storage-class', ok, required: true, detail: ok ? 'available' : 'none found', ...(ok ? {} : { fix: 'Configure a default StorageClass or use external Matrix' }) }) }
    catch { checks.push({ name: 'storage-class', ok: false, required: true, detail: 'could not inspect', fix: 'Grant get on storageclasses' }) }
    return { kind: this.kind, available: checks.every(check => !check.required || check.ok), checks }
  }
  async prepare(signal?: AbortSignal): Promise<void> { const detection = await this.detect(signal); if (!detection.available) throw new RuntimeError('IMESSAGE_RUNTIME_PERMISSION_DENIED', 'The existing Kubernetes cluster does not meet runtime requirements', 'Resolve the failed runtime checks or choose external Matrix', false) }
  async start(signal?: AbortSignal): Promise<void> { await this.prepare(signal) }
  async status(signal?: AbortSignal): Promise<RuntimeStatus> { const detection = await this.detect(signal); return { kind: this.kind, health: detection.available ? 'ready' : 'unavailable', detail: detection.available ? 'Existing Kubernetes cluster is ready' : 'Existing Kubernetes cluster needs attention', checks: detection.checks, lastCheckedAt: new Date().toISOString() } }
  async apply(bundle: DeploymentBundle, signal?: AbortSignal): Promise<void> {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(bundle.namespace)) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Invalid Kubernetes namespace', undefined, false)
    if (bundle.manifestPaths.length === 0) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Deployment bundle has no manifests', undefined, false)
    await this.prepare(signal)
    await this.command(['create', 'namespace', bundle.namespace, '--dry-run=client', '-o', 'yaml'], signal).then(yaml => this.command(['apply', '-f', '-'], signal, yaml))
    for (const path of bundle.manifestPaths) { await access(path, constants.R_OK); await this.command(['apply', '--namespace', bundle.namespace, '-f', path], signal) }
  }
  async stop(_signal?: AbortSignal): Promise<void> { /* Existing clusters are never stopped by the plugin. */ }
  async remove(signal?: AbortSignal): Promise<void> { await this.command(['delete', 'namespace', this.namespace, '--ignore-not-found=true'], signal) }
  async *logs(options: RuntimeLogOptions): AsyncIterable<string> {
    const args = ['logs', '--namespace', options.namespace, '--tail', String(Math.min(options.tail ?? 200, 1000)), ...(options.selector ? ['--selector', options.selector] : ['--all-containers=true'])]
    const output = await this.command(args, options.signal)
    for (const line of output.split(/\r?\n/)) if (line) yield line.slice(0, 4096)
  }
}
