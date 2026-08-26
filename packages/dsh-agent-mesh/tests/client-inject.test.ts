import { describe, expect, it } from 'vitest'

/**
 * The dsh client runtime gates contextual property access by the plugin's
 * declared inject list, and a namespace service (remote.<ns>) only exists
 * once SOME plugin mounts its contribution. Two failure modes, both seen
 * live on 2026-08-26:
 *  - declaring NO sub-namespace inject and touching ctx.remote.agentMeshWeb
 *    → "cannot get property without inject" at plugin application
 *  - declaring the sub-namespace on the SAME plugin that mounts the
 *    contribution → circular wait: "pending (waiting for service:
 *    remote.agentMeshWeb)" forever
 * The split: the package entry mounts the contribution (no sub-namespace
 * inject); a child plugin declares remote.agentMeshWeb and mounts the UI.
 */
describe('agent-mesh client plugin', () => {
  it('mounts the contribution from an entry that does NOT wait on its own namespace', async () => {
    const client = await import('../src/client/index.js')
    expect(client.inject).toContain('remote')
    expect(client.inject).toContain('slots')
    expect(client.inject).toContain('settingsScope')
    expect(client.inject).not.toContain('remote.agentMeshWeb')
  })

  it('registers the UI as a child plugin that declares the namespace', async () => {
    const client = await import('../src/client/index.js')
    let seen: { name?: string; inject?: readonly string[] } | undefined
    const ctx = {
      remote: { $mount: async () => async () => {} },
      slots: { inject: () => {}, register: () => {} },
      settingsScope: { bind: () => ({ getSnapshot: () => ({ status: 'unavailable' }), subscribe: () => () => {}, set: async () => {}, unset: async () => {} }) },
      plugin: (spec: { name?: string; inject?: readonly string[]; apply: (ctx: unknown) => void }) => {
        seen = spec
        return { dispose: async () => {} }
      },
    }
    await client.apply(ctx as never)
    expect(seen?.name).toBe('agent-mesh-ui')
    expect(seen?.inject).toContain('remote.agentMeshWeb')
  })
})
