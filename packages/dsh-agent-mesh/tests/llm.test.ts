import { describe, expect, it, vi } from 'vitest'
import { SamLlmAdapter } from '../src/llm/index.js'
import type { ChatCompletionChunk } from '../src/inference/index.js'

async function collect(source: AsyncIterable<unknown>) { const out=[]; for await (const value of source) out.push(value); return out }
function inference(chunks: ChatCompletionChunk[]) { return {
  models: vi.fn(async () => ({ object: 'list', data: [{ id: 'mesh-model', name: 'Mesh Model' }] })),
  chat: vi.fn(async () => (async function*(){ yield* chunks })()),
} }

describe('SamLlmAdapter', () => {
  it('refreshes the facade catalog and never caches when ttl is zero', async () => {
    const api = inference([]); const adapter = new SamLlmAdapter(api as any, { modelsTtlMs: 0 })
    expect((await adapter.listModels('sam-mesh'))[0]).toMatchObject({ provider: 'sam-mesh', id: 'mesh-model' })
    await adapter.listModels('sam-mesh'); expect(api.models).toHaveBeenCalledTimes(2)
  })
  it('converts fragmented text, tool calls, usage and finish chunks', async () => {
    const api = inference([
      { id:'1', object:'chat.completion.chunk', created:1, model:'m', choices:[{ index:0, delta:{ content:'hi', tool_calls:[{index:0,id:'c',function:{name:'go',arguments:'{'}}]}}] },
      { id:'1', object:'chat.completion.chunk', created:1, model:'m', choices:[{ index:0, delta:{ tool_calls:[{index:0,function:{arguments:'}'}}]}, finish_reason:'tool_calls'}], usage:{prompt_tokens:2,completion_tokens:3} },
    ] as any)
    const adapter = new SamLlmAdapter(api as any, { requiredLabels:['gpu=h100'] })
    const chunks = await collect(adapter.stream({ provider:'sam-mesh', model:'m', messages:[] })) as any[]
    expect(chunks).toContainEqual({ type:'text-delta', index:1, text:'hi' })
    expect(chunks.at(-1)).toEqual({ type:'finish', reason:{kind:'tool-calls'} })
    expect((api.chat as any).mock.calls[0]?.[1]).toMatchObject({ requiredLabels:['gpu=h100'] })
  })
  it('declares zero local retries because SAM owns routing/failover', () => {
    const adapter = new SamLlmAdapter(inference([]) as any)
    expect(adapter.providerRetryPolicy()).toMatchObject({ mode:'normal', maxRetries:0 })
  })
})

describe('fleet capability injection', () => {
  it('sends x-fleet-capability on execution when a resolver is configured', async () => {
    const api = inference([])
    const adapter = new SamLlmAdapter(api as any, {}, async () => 'fleet-cap')
    await collect(adapter.stream({ provider: 'sam-mesh', model: 'm', messages: [] }))
    expect((api.chat.mock.calls[0] as any[])[1].serviceHeaders).toEqual({ 'x-fleet-capability': 'fleet-cap' })
  })
  it('omits the header when the store has no credential, and never sends it on model listing', async () => {
    const api = inference([])
    const adapter = new SamLlmAdapter(api as any, {}, async () => undefined)
    await collect(adapter.stream({ provider: 'sam-mesh', model: 'm', messages: [] }))
    expect((api.chat.mock.calls[0] as any[])[1].serviceHeaders).toBeUndefined()
    await adapter.listModels('sam-mesh')
    expect((api.models.mock.calls[0] as any[])[0].serviceHeaders).toBeUndefined()
  })
  it('resolves per call (rotation-safe)', async () => {
    const api = inference([])
    let value = 'cap-a'
    const adapter = new SamLlmAdapter(api as any, {}, async () => value)
    await collect(adapter.stream({ provider: 'sam-mesh', model: 'm', messages: [] }))
    value = 'cap-b'
    await collect(adapter.stream({ provider: 'sam-mesh', model: 'm', messages: [] }))
    expect((api.chat.mock.calls[0] as any[])[1].serviceHeaders['x-fleet-capability']).toBe('cap-a')
    expect((api.chat.mock.calls[1] as any[])[1].serviceHeaders['x-fleet-capability']).toBe('cap-b')
  })
})
