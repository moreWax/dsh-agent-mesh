import { describe, expect, it, vi } from 'vitest'
import { SamClient } from '@morewax/sam-mesh'
import {
  InferenceProtocolError,
  InferenceStreamingUnsupportedError,
  SamInferenceClient,
  type SamHttpRequestOptions,
} from '../src/inference/index.js'

function fake(response: unknown) {
  const request = vi.fn(async (_path: string, _options?: SamHttpRequestOptions) => response)
  return { request: request as unknown as <T>(path: string, options?: SamHttpRequestOptions) => Promise<T>, spy: request }
}

describe('SamInferenceClient', () => {
  it('accepts the core SamClient structurally', () => {
    const core = new SamClient({ socketPath: false })
    expect(new SamInferenceClient(core)).toBeInstanceOf(SamInferenceClient)
  })
  it('lists facade models in auto mode', async () => {
    const transport = fake({ object: 'list', data: [{ id: 'm1' }] })
    const result = await new SamInferenceClient(transport).models()
    expect(result.data[0]?.id).toBe('m1')
    expect(transport.spy).toHaveBeenCalledOnce()
    expect(transport.spy).toHaveBeenCalledWith('/v1/models', {
      method: 'GET', headers: {},
    })
  })

  it('does one non-streaming chat request and passes any-of labels', async () => {
    const completion = { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] }
    const transport = fake(completion)
    const result = await new SamInferenceClient(transport).chat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { requiredLabels: ['region=eu', 'gpu=h100'] },
    )
    expect(result).toBe(completion)
    expect(transport.spy).toHaveBeenCalledOnce()
    expect(transport.spy.mock.calls[0]?.[0]).toBe('/v1/chat/completions')
    expect((transport.spy.mock.calls[0]?.[1] as SamHttpRequestOptions).headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Sam-Required-Labels': 'region=eu,gpu=h100',
    })
  })

  it('pins to a discovered local proxy while retaining core transport', async () => {
    const transport = fake({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] })
    await new SamInferenceClient(transport).chat(
      { model: 'm', messages: [] },
      { route: { mode: 'pinned', localProxyUrl: 'http://127.0.0.1:8080/sam/peer/inference/srv' } },
    )
    expect(transport.spy.mock.calls[0]?.[0]).toBe('/sam/peer/inference/srv/v1/chat/completions')
  })

  it('validates labels before sending', async () => {
    const transport = fake({})
    await expect(new SamInferenceClient(transport).models({ requiredLabels: ['bad'] }))
      .rejects.toBeInstanceOf(InferenceProtocolError)
    expect(transport.spy).not.toHaveBeenCalled()
  })

  it('rejects streaming when the core transport does not expose it', async () => {
    await expect(new SamInferenceClient(fake({})).chat({ model: 'm', messages: [], stream: true }))
      .rejects.toBeInstanceOf(InferenceStreamingUnsupportedError)
  })

  it('parses fragmented OpenAI SSE without issuing a second request', async () => {
    const request = vi.fn()
    const requestStream = vi.fn((_path: string, _options: SamHttpRequestOptions) => (async function* () {
      yield 'data: {"id":"1","object":"chat.completion.chunk","created":1,'
      yield '"model":"m","choices":[]}\n\ndata: [DONE]\n\n'
    })())
    const stream = await new SamInferenceClient({ request, requestStream }).chat({ model: 'm', messages: [], stream: true })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.id).toBe('1')
    expect(requestStream).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not retry transport failures', async () => {
    const transport = { request: vi.fn(async () => { throw new Error('down') }) }
    await expect(new SamInferenceClient(transport).models()).rejects.toMatchObject({
      code: 'SAM_MODELS_FAILED', cause: expect.any(Error),
    })
    expect(transport.request).toHaveBeenCalledOnce()
  })
})
