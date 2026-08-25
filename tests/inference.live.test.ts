import { describe, expect, it } from 'vitest'
import { SamClient, SamHttpError } from '../src/core/index.js'
import { InferenceError, SamInferenceClient } from '../src/inference/index.js'

const live = process.env.SAM_LIVE === '1' ? describe : describe.skip
const IMPOSSIBLE_LABEL = 'sam-live-acceptance=impossible-7fdbcca7'

function isSafeLocalProxy(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
      && url.pathname.startsWith('/sam/')
  } catch {
    return false
  }
}

live('live native SAM inference', () => {
  it('lists real models and streams one short, non-sensitive completion over auto routing', async () => {
    const inference = new SamInferenceClient(new SamClient({ timeoutMs: 60_000 }))
    const models = await inference.models()

    expect(models.object).toBe('list')
    expect(models.data.length).toBeGreaterThan(0)
    expect(models.data.every((model) => typeof model.id === 'string' && model.id.length > 0)).toBe(true)

    const stream = await inference.chat({
      model: models.data[0]!.id,
      messages: [{ role: 'user', content: 'Reply with only the word OK.' }],
      stream: true,
      max_tokens: 4,
      temperature: 0,
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true)
    expect(chunks.some((chunk) => chunk.model === models.data[0]!.id)).toBe(true)
  }, 90_000)

  it('uses a safely discovered pinned inference route when one is advertised', async (context) => {
    const core = new SamClient({ timeoutMs: 60_000 })
    const services = await core.discoverRemoteServices({ type: 'inference' })
    const localProxyUrl = services.map((service) => service.local_proxy_url).find(isSafeLocalProxy)
    if (!localProxyUrl) {
      context.skip('SAM did not advertise a loopback inference proxy suitable for pinning')
      return
    }

    const models = await new SamInferenceClient(core).models({
      route: { mode: 'pinned', localProxyUrl },
    })
    expect(models.data.length).toBeGreaterThan(0)
  }, 90_000)

  it('denies an impossible required label and preserves typed transport errors', async () => {
    const core = new SamClient({ timeoutMs: 60_000 })
    const inference = new SamInferenceClient(core)
    const models = await inference.models()
    expect(models.data.length).toBeGreaterThan(0)

    let failure: unknown
    try {
      await inference.chat({
        model: models.data[0]!.id,
        messages: [{ role: 'user', content: 'Reply with only the word OK.' }],
        max_tokens: 1,
      }, { requiredLabels: [IMPOSSIBLE_LABEL] })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(InferenceError)
    expect(failure).toMatchObject({ code: 'SAM_CHAT_FAILED' })
    expect((failure as InferenceError).cause).toBeInstanceOf(SamHttpError)
    expect((failure as InferenceError).cause).toMatchObject({ status: 503 })
  }, 90_000)
})
