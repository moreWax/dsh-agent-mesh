/** Pure platform/backend selection. This module must stay platform-neutral. */
export type BackendChoice = 'auto' | 'native' | 'matrix'
export type SelectedBackend = 'native' | 'matrix' | 'unsupported'
export type Platform = 'darwin' | 'linux' | 'other'

export function platformOf(platform = process.platform): Platform {
  return platform === 'darwin' || platform === 'linux' ? platform : 'other'
}

/** Explicit profile choice wins, then persisted setup choice, then platform default. */
export function selectBackend(choice: BackendChoice | undefined, platform: Platform = platformOf(), persisted?: BackendChoice): SelectedBackend {
  const effective = choice && choice !== 'auto' ? choice : persisted && persisted !== 'auto' ? persisted : 'auto'
  if (effective === 'native') return platform === 'darwin' ? 'native' : 'unsupported'
  if (effective === 'matrix') return platform === 'linux' ? 'matrix' : 'unsupported'
  return platform === 'darwin' ? 'native' : platform === 'linux' ? 'matrix' : 'unsupported'
}
