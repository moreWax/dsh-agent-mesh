/** Platform implementations are loaded only after selection. */
import type { IMessageBackend } from './interface.js'
import type { SelectedBackend } from './select.js'
import { IMessageError } from './errors.js'

export interface NativeLoadConfig { dbPath: string; allowSms: boolean }
export interface MatrixLoadConfig { homeserverUrl: string; accessToken: string; roomId: string }
export interface BackendModules { native(): Promise<{ NativeBackend: new (dbPath: string, allowSms: boolean) => IMessageBackend }>; matrix(): Promise<{ BridgeBackend: new (config: MatrixLoadConfig) => IMessageBackend }> }
const defaultModules: BackendModules = { native: async () => await import('./native.js'), matrix: async () => await import('./bridge.js') }

export async function loadBackend(selected: SelectedBackend, config: { native?: NativeLoadConfig; matrix?: MatrixLoadConfig }, modules: BackendModules = defaultModules): Promise<IMessageBackend> {
  if (selected === 'native') {
    if (!config.native) throw new IMessageError('IMESSAGE_NOT_CONFIGURED', 'The native backend is not configured', { retryable: false })
    const { NativeBackend } = await modules.native()
    return new NativeBackend(config.native.dbPath, config.native.allowSms)
  }
  if (selected === 'matrix') {
    if (!config.matrix) throw new IMessageError('IMESSAGE_NOT_CONFIGURED', 'The Matrix backend is not configured', { fix: 'Configure the homeserver, room, and credential reference in dsh Settings', retryable: false })
    const { BridgeBackend } = await modules.matrix()
    return new BridgeBackend(config.matrix)
  }
  throw new IMessageError('IMESSAGE_BACKEND_UNAVAILABLE', `iMessage is unsupported on this platform`, { retryable: false })
}
