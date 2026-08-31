export type RuntimeKind = 'existing-kubernetes' | 'rootless-k3s' | 'external-matrix'
export type RuntimeHealth = 'ready' | 'not-configured' | 'unavailable' | 'degraded'

export interface RuntimeCheck { name: string; ok: boolean; required: boolean; detail: string; fix?: string }
export interface RuntimeDetection { kind: RuntimeKind; available: boolean; checks: RuntimeCheck[] }
export interface RuntimeStatus { kind: RuntimeKind; health: RuntimeHealth; detail: string; checks: RuntimeCheck[]; lastCheckedAt: string }
export interface DeploymentBundle { namespace: string; manifestPaths: string[]; id: string; version: string }
export interface RuntimeLogOptions { namespace: string; selector?: string; tail?: number; signal?: AbortSignal }

export interface IMessageRuntime {
  readonly kind: RuntimeKind
  detect(signal?: AbortSignal): Promise<RuntimeDetection>
  prepare(signal?: AbortSignal): Promise<void>
  start(signal?: AbortSignal): Promise<void>
  status(signal?: AbortSignal): Promise<RuntimeStatus>
  stop(signal?: AbortSignal): Promise<void>
  remove(signal?: AbortSignal): Promise<void>
  logs(options: RuntimeLogOptions): AsyncIterable<string>
}

export interface ClusterRuntime extends IMessageRuntime {
  readonly kind: 'existing-kubernetes' | 'rootless-k3s'
  apply(bundle: DeploymentBundle, signal?: AbortSignal): Promise<void>
}

export interface ExternalMatrixValidation {
  homeserverUrl: string
  accessToken: string
  roomId: string
  bridgeHealthUrl?: string
}
