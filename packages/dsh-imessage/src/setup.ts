/** Pure/resumable iMessage setup state machine. I/O lives in the plugin edge. */
export type SetupState =
  | 'unconfigured' | 'detecting' | 'native-needs-permission' | 'linux-needs-runtime'
  | 'linux-needs-hardware-key' | 'matrix-needs-config' | 'matrix-needs-auth'
  | 'bridge-starting' | 'ready' | 'degraded' | 'failed'

export interface SetupFacts {
  platform: 'darwin' | 'linux' | 'other'
  backend: 'native' | 'matrix' | 'unsupported'
  nativeReadable?: boolean
  matrixConfigured?: boolean
  matrixReachable?: boolean
  bridgeReady?: boolean
  hardwareKeyPresent?: boolean
  runtimeReady?: boolean
}

export function setupState(facts: SetupFacts): SetupState {
  if (facts.platform === 'other' || facts.backend === 'unsupported') return 'failed'
  if (facts.backend === 'native') return facts.nativeReadable === false ? 'native-needs-permission' : 'ready'
  if (!facts.runtimeReady) return 'linux-needs-runtime'
  if (!facts.hardwareKeyPresent) return 'linux-needs-hardware-key'
  if (!facts.matrixConfigured) return 'matrix-needs-config'
  if (facts.matrixReachable === false) return 'degraded'
  if (!facts.bridgeReady) return 'matrix-needs-auth'
  return 'ready'
}

export interface SetupAction { id: 'check' | 'create-runtime' | 'provide-key' | 'configure-matrix' | 'activate' | 'retry'; label: string }
export function nextSetupActions(state: SetupState): SetupAction[] {
  switch (state) {
    case 'linux-needs-runtime': return [{ id: 'create-runtime', label: 'Create private rootless cluster' }, { id: 'retry', label: 'Use an existing cluster' }]
    case 'linux-needs-hardware-key': return [{ id: 'provide-key', label: 'Provide hardware validation data' }]
    case 'matrix-needs-config': return [{ id: 'configure-matrix', label: 'Configure Matrix bridge' }]
    case 'matrix-needs-auth': return [{ id: 'activate', label: 'Activate iMessage account' }]
    case 'native-needs-permission': return [{ id: 'check', label: 'Grant macOS permissions' }]
    case 'degraded': case 'failed': return [{ id: 'retry', label: 'Retry setup' }]
    case 'unconfigured': case 'detecting': case 'bridge-starting': return [{ id: 'check', label: 'Check setup' }]
    case 'ready': return []
  }
}
