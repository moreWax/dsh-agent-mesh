import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVE_CONFIG, readServeConfig, writeServeConfig, SERVE_BLOCK_BEGIN } from '../src/web/serve-patch.js'

const CONFIG = { ...DEFAULT_SERVE_CONFIG, enabled: true, target: 'auto', announceName: 'my-models' }

describe('serve-patch managed block', () => {
  it('round-trips a fresh patch', () => {
    const text = writeServeConfig('', CONFIG)
    expect(text).toContain(SERVE_BLOCK_BEGIN)
    expect(readServeConfig(text)).toEqual({ ...CONFIG, upstreamAuthCredentialRef: '', modelAllowlist: [] })
  })
  it('preserves existing rows and replaces its own block idempotently', () => {
    const existing = '- id: agent-mesh\n  config:\n    callCapabilityRef: MESH_TASK_CAPABILITY\n'
    const once = writeServeConfig(existing, CONFIG)
    expect(once).toContain('callCapabilityRef')
    const twice = writeServeConfig(once, { ...CONFIG, announceName: 'renamed' })
    expect(twice.match(new RegExp(SERVE_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))!.length).toBe(1)
    expect(readServeConfig(twice)?.announceName).toBe('renamed')
  })
  it('removes cleanly on disable', () => {
    const text = writeServeConfig(writeServeConfig('- id: agent-mesh\n', CONFIG), null)
    expect(text).not.toContain('agent-mesh-inference')
    expect(text).toContain('- id: agent-mesh')
    expect(readServeConfig(text)).toBeNull()
  })
  it('reads allowlist and upstream ref, and ignores hand-written rows outside the markers', () => {
    const text = writeServeConfig('', { ...CONFIG, upstreamAuthCredentialRef: 'MY_KEY', modelAllowlist: ['a', 'b'] })
    expect(readServeConfig(text)).toMatchObject({ upstreamAuthCredentialRef: 'MY_KEY', modelAllowlist: ['a', 'b'] })
    expect(readServeConfig('- insert:\n    - id: agent-mesh-inference\n      config:\n        target: http://x\n')).toBeNull()
  })
})
