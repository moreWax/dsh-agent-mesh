import { describe, expect, it, vi } from 'vitest'
import { MeshObservability } from '../src/observability/index.js'
import { InferenceConsentError, SamInferenceClient } from '../src/inference/index.js'

describe('payload-free observability', () => {
  it('aggregates structured bounded dimensions in snapshots', () => {
    const metrics = new MeshObservability(undefined, () => 0)
    metrics.record('discovery', { completeness: 'partial', outcome: 'partial', provider: 'peer\nsecret' }, 4)
    metrics.record('discovery', { completeness: 'partial', outcome: 'partial', provider: 'peersecret' }, 6)
    expect(metrics.snapshot()).toEqual({ capturedAt: '1970-01-01T00:00:00.000Z', sequence: 2,
      points: [{ kind: 'discovery', completeness: 'partial', outcome: 'partial', provider: 'peersecret', count: 2, durationMs: 10 }] })
  })

  it('requires attribution and approval for sensitive pinned inference and audits metadata only', async () => {
    const events: unknown[] = []
    const calls: Array<[string, any]> = []
    const request = async <T>(path: string, options?: any): Promise<T> => { calls.push([path, options]); return { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] } as T }
    const client = new SamInferenceClient({ request }, { observability: new MeshObservability(event => { events.push(event) }, () => 0) })
    const route = { mode: 'pinned' as const, localProxyUrl: 'http://localhost/peer', provider: 'peer-a' }
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'SECRET' }] }, { route, sensitivity: 'sensitive' }))
      .rejects.toBeInstanceOf(InferenceConsentError)
    await client.chat({ model: 'm', messages: [{ role: 'user', content: 'SECRET' }] }, {
      route, sensitivity: 'sensitive', correlationId: 'trace-1', consent: () => ({ approved: true, approvedBy: 'operator' }),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]?.headers).toMatchObject({ 'X-Correlation-Id': 'trace-1' })
    expect(JSON.stringify(events)).not.toContain('SECRET')
    expect(events).toContainEqual(expect.objectContaining({ correlationId: 'trace-1', provider: 'peer-a', model: 'm', outcome: 'ok' }))
  })

  it('never permits sensitive auto routing', async () => {
    const client = new SamInferenceClient({ request: vi.fn() })
    await expect(client.models({ sensitivity: 'sensitive', consent: () => true })).rejects.toThrow('pinned')
  })
})
