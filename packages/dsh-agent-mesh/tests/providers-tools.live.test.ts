import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SamClient } from '@morewax/sam-mesh'
import { SamToolClient } from '../src/tools/index.js'
import { projectedToolName, SamToolsProvider } from '../src/providers/tools.js'

const live = process.env.SAM_LIVE === '1' ? describe : describe.skip

live('live native SAM ctx.tools provider', () => {
  it('projects and invokes the exact remote echo tool with atomic refresh generations', async () => {
    const core = new SamClient({ socketPath: '~/.config/sam-mesh/sam.sock'.replace('~', process.env.HOME ?? '') })
    const tools = new SamToolClient(core)
    const echoes = await tools.find({ toolName: 'echo' })
    const echo = echoes.tools.find(tool => tool.uri === 'mcp://everything/echo')
    expect(echo, `live SAM catalogue did not contain mcp://everything/echo: ${JSON.stringify(echoes)}`).toBeDefined()

    const describeSpy = vi.spyOn(tools, 'describe')
    const registered = new Map<string, any>()
    let maximumRegistered = 0
    const registry = {
      register(definition: any) {
        if (registered.has(definition.name)) throw new Error(`duplicate native tool: ${definition.name}`)
        registered.set(definition.name, definition)
        maximumRegistered = Math.max(maximumRegistered, registered.size)
        return () => { if (registered.get(definition.name) === definition) registered.delete(definition.name) }
      },
    }
    const ctx = new Context() as any
    ctx.provide('agentMesh', { core, tools })
    ctx.provide('tools', registry)
    const provider = new SamToolsProvider(ctx, { peerId: echo!.peerId, toolName: 'echo' })

    await provider.refresh()
    expect(describeSpy).toHaveBeenCalledTimes(1)
    expect(describeSpy.mock.calls[0]?.[2]).toMatchObject({ force: true })
    expect(registered.size).toBe(1)
    const stableName = projectedToolName(echo!.peerId, echo!.uri)
    expect([...registered.keys()]).toEqual([stableName])

    const definition = registered.get(stableName)!
    const marker = `sam-live-${Date.now()}`
    const result = await definition.execute({ message: marker }, { signal: new AbortController().signal })
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: `Echo: ${marker}` }))

    await provider.refresh()
    expect(describeSpy).toHaveBeenCalledTimes(3) // refresh describe + execute's schema revalidation
    expect([...registered.keys()]).toEqual([stableName])
    expect(maximumRegistered).toBe(1)

    describeSpy.mockRejectedValueOnce(new Error('injected describe failure'))
    await expect(provider.refresh()).rejects.toThrow('injected describe failure')
    expect([...registered.keys()]).toEqual([stableName])
    expect(registered.get(stableName)).toBeDefined()

    provider.dispose()
    expect(registered.size).toBe(0)
  })
})
