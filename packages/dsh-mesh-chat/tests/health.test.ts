import { describe, expect, it } from 'vitest'
import { healthOf, healthTopic } from '../src/health.js'
import { FleetPublisher } from '../src/notifier.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('fleet health beacon', () => {
  it('healthOf parses beacon messages and ignores chat', () => {
    const health = { kind: 'dsh-fleet-health', hubConsistent: false, rejectionCount: 4, ts: 1 }
    const parsed = healthOf({ channel: 'fleet-health', sender: 'health-beacon', text: JSON.stringify(health) })
    expect(parsed).toMatchObject({ hubConsistent: false, rejectionCount: 4 })
    expect(healthOf({ channel: 'fleet', sender: 'mac', text: 'hello' })).toBeUndefined()
    expect(healthOf({ sender: 'health-beacon', text: 'not json' })).toBeUndefined()
  })
  it('topic is per-fleet', () => {
    expect(healthTopic('dsh-task-service')).toBe('dsh-chat/health/dsh-task-service')
  })
  it('emits the initial state, transitions, and heartbeats — sealed per member', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beacon-'))
    await writeFile(join(dir, 'fleet-members.json'), JSON.stringify({ version: 1, members: [{ id: 'm1', name: 'mac', capability: 'cap-mac', scopes: ['tasks'], createdAt: 'x' }] }))
    const broadcasts: Array<{ topic: string; payload: string }> = []
    const bus = { callTool: async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      if (name === 'mesh_pubsub_broadcast') { broadcasts.push({ topic: String(args.topic), payload: String(args.payload) }); return {} as T }
      throw new Error(`unexpected ${name}`)
    } }
    const publisher = new FleetPublisher(bus, { serviceName: 'fleet', membersPath: join(dir, 'fleet-members.json') })
    const { startHealthBeacon } = await import('../src/health.js')
    let healthy = true
    const stop = startHealthBeacon({
      serviceName: 'fleet', publisher, bus,
      heartbeatMs: 30, probeMs: 20,
      dataDir: dir,
      onTransition: h => { healthy = h },
    })
    await new Promise(r => setTimeout(r, 90))
    stop()
    expect(broadcasts.length).toBeGreaterThanOrEqual(2) // initial + at least one heartbeat
    expect(broadcasts[0]!.topic).toBe('dsh-chat/health/fleet')
    const envelope = JSON.parse(Buffer.from(broadcasts[0]!.payload, 'base64url').toString('utf8')) as { sealed: Record<string, unknown> }
    expect(Object.keys(envelope.sealed)).toContain('m1')
    expect(healthy).toBe(true) // no transitions in an empty log dir
  })
})
