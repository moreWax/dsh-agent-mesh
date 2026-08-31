/** Pure platform/backend selection. No filesystem or network I/O. */
import type { IMessageBackend } from './interface.js'
import { NativeBackend } from './native.js'
import { BridgeBackend, type BridgeConfig } from './bridge.js'

export type BackendChoice = 'auto' | 'native' | 'matrix'
export type Platform = 'darwin' | 'linux' | 'other'

export function platformOf(platform = process.platform): Platform {
  return platform === 'darwin' || platform === 'linux' ? platform : 'other'
}

export function selectBackend(choice: BackendChoice, platform: Platform = platformOf()): 'native' | 'matrix' | 'unsupported' {
  if (choice === 'native') return platform === 'darwin' ? 'native' : 'unsupported'
  if (choice === 'matrix') return platform === 'linux' ? 'matrix' : 'unsupported'
  return platform === 'darwin' ? 'native' : platform === 'linux' ? 'matrix' : 'unsupported'
}

export function createBackend(options: {
  choice: BackendChoice
  platform?: Platform
  native?: { dbPath: string; allowSms: boolean }
  matrix?: BridgeConfig
}): IMessageBackend {
  const selected = selectBackend(options.choice, options.platform)
  if (selected === 'native' && options.native) return new NativeBackend(options.native.dbPath, options.native.allowSms)
  if (selected === 'matrix' && options.matrix) return new BridgeBackend(options.matrix)
  if (selected === 'matrix') throw new Error('Linux iMessage backend is not configured — configure corten-matrix/Matrix in Settings → iMessage')
  if (selected === 'native') throw new Error('macOS native iMessage backend is not configured')
  throw new Error(`iMessage is unsupported on this platform (${options.platform ?? platformOf()})`)
}
