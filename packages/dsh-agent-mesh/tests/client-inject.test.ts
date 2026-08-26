import { describe, expect, it } from 'vitest'

/**
 * The dsh client runtime gates contextual property access by the plugin's
 * declared inject list: touching ctx.remote.<namespace> without declaring
 * 'remote.<namespace>' fails plugin application with "cannot get property
 * without inject" — in the BROWSER, where our test suite never ran. Pin the
 * declaration so the failure is a red test, not a broken card. (Postmortem:
 * the card's first live render, 2026-08-26.)
 */
describe('agent-mesh client plugin', () => {
  it('declares inject for every remote namespace it accesses', async () => {
    const client = await import('../src/client/index.js')
    expect(client.inject).toContain('remote')
    expect(client.inject).toContain('remote.agentMeshWeb')
    expect(client.inject).toContain('slots')
    expect(client.inject).toContain('settingsScope')
  })
})
