/** Managed serve-row block in the profile patch: the card owns everything between the markers. */
export interface ServeRowConfig {
  enabled: boolean
  target: string
  port: number
  announceName: string
  upstreamAuthCredentialRef: string
  modelAllowlist: string[]
}

export const SERVE_BLOCK_BEGIN = '# BEGIN agent-mesh-inference (managed by the agent-mesh card — edit there, not by hand)'
export const SERVE_BLOCK_END = '# END agent-mesh-inference'

export const DEFAULT_SERVE_CONFIG: ServeRowConfig = {
  enabled: false,
  target: 'auto',
  port: 4100,
  announceName: 'dsh-mesh-inference',
  upstreamAuthCredentialRef: '',
  modelAllowlist: [],
}

function renderBlock(config: ServeRowConfig): string {
  const lines = [
    SERVE_BLOCK_BEGIN,
    '- insert:',
    "    - id: agent-mesh-inference",
    "      name: '@morewax/dsh-agent-mesh/inference/serve'",
    '      config:',
    `        target: ${config.target}`,
    '        host: 127.0.0.1',
    `        port: ${config.port}`,
    `        announceName: ${config.announceName}`,
  ]
  if (config.upstreamAuthCredentialRef) lines.push(`        upstreamAuthCredentialRef: ${config.upstreamAuthCredentialRef}`)
  if (config.modelAllowlist.length > 0) lines.push(`        modelAllowlist: [${config.modelAllowlist.join(', ')}]`)
  lines.push(SERVE_BLOCK_END)
  return lines.join('\n')
}

/** Parse the managed block; null when absent. Hand-written serve rows outside the markers are NOT adopted — the card never claims what it did not write. */
export function readServeConfig(patch: string): ServeRowConfig | null {
  const begin = patch.indexOf(SERVE_BLOCK_BEGIN)
  const end = patch.indexOf(SERVE_BLOCK_END)
  if (begin < 0 || end < begin) return null
  const block = patch.slice(begin, end)
  const grab = (key: string): string | undefined => {
    const match = block.match(new RegExp(`^\\s+${key}: (.+)$`, 'm'))
    return match?.[1]?.trim()
  }
  return {
    enabled: true,
    target: grab('target') ?? DEFAULT_SERVE_CONFIG.target,
    port: Number(grab('port') ?? DEFAULT_SERVE_CONFIG.port),
    announceName: grab('announceName') ?? DEFAULT_SERVE_CONFIG.announceName,
    upstreamAuthCredentialRef: grab('upstreamAuthCredentialRef') ?? '',
    modelAllowlist: (grab('modelAllowlist') ?? '').replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean),
  }
}

/** Insert, replace, or (config null) remove the managed block. */
export function writeServeConfig(patch: string, config: ServeRowConfig | null): string {
  const begin = patch.indexOf(SERVE_BLOCK_BEGIN)
  const end = patch.indexOf(SERVE_BLOCK_END)
  const had = begin >= 0 && end >= begin
  const base = had
    ? (patch.slice(0, begin) + patch.slice(end + SERVE_BLOCK_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
    : patch
  if (config === null || !config.enabled) return base
  const block = renderBlock(config)
  return (base.endsWith('\n') ? base : base + '\n') + (base.trim() === '' ? '' : '\n') + block + '\n'
}
