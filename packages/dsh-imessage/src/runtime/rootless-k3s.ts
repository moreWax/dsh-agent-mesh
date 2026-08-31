import type { ClusterRuntime, DeploymentBundle, RuntimeDetection, RuntimeLogOptions, RuntimeStatus } from './interface.js'
import { RuntimeError } from './errors.js'

/** Task-4 boundary only. Task 5 supplies pinned artifacts and process management. */
export class RootlessK3sRuntime implements ClusterRuntime {
  readonly kind = 'rootless-k3s' as const
  async detect(_signal?: AbortSignal): Promise<RuntimeDetection> { return { kind: this.kind, available: false, checks: [{ name: 'runtime-bundle', ok: false, required: true, detail: 'not installed', fix: 'Install the pinned rootless runtime bundle through iMessage setup' }] } }
  private unavailable(): never { throw new RuntimeError('IMESSAGE_RUNTIME_NOT_CONFIGURED', 'The rootless k3s runtime is not installed', 'Continue with the pinned rootless runtime setup step', false) }
  async prepare(_signal?: AbortSignal): Promise<void> { this.unavailable() }
  async start(_signal?: AbortSignal): Promise<void> { this.unavailable() }
  async status(_signal?: AbortSignal): Promise<RuntimeStatus> { const d = await this.detect(); return { kind: this.kind, health: 'not-configured', detail: 'Rootless k3s is not installed', checks: d.checks, lastCheckedAt: new Date().toISOString() } }
  async apply(_bundle: DeploymentBundle, _signal?: AbortSignal): Promise<void> { this.unavailable() }
  async stop(_signal?: AbortSignal): Promise<void> {}
  async remove(_signal?: AbortSignal): Promise<void> {}
  async *logs(_options: RuntimeLogOptions): AsyncIterable<string> { this.unavailable() }
}
