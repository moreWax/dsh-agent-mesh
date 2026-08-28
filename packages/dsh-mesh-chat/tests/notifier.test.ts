import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seal, open, deriveNotifyKeys, deriveNotifyPublicKey } from '@morewax/sam-mesh'
import { FleetPublisher, FleetSubscriber, chatTopic } from '../src/notifier.js'
import type { NotifyEnvelope } from '../src/notifier.js'

describe('deriveNotifyKeys', () => {
  it('is deterministic per capability and different across capabilities; seal/open round-trips', () => {
    const a1 = deriveNotifyKeys('cap-a')
    const a2 = deriveNotifyKeys('cap-a')
    const b = deriveNotifyKeys('cap-b')
    expect(a1.publicKeyX).toBe(a2.publicKeyX)
    expect(a1.publicKeyX).not.toBe(b.publicKeyX)
    const sealed = seal('hello', deriveNotifyPublicKey('cap-a'))
    expect(open(sealed, a1.privateKey)).toBe('hello')
    expect(() => open(sealed, b.privateKey)).toThrow()
  })
})

function fakeBus() {
  const broadcasts: Array<{ topic: string; payload: string }> = []
  const subscriptions: string[] = []
  const bus = {
    callTool: async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      if (name === 'mesh_pubsub_broadcast') { broadcasts.push({ topic: String(args.topic), payload: String(args.payload) }); return {} as T }
      if (name === 'subscribe_topic') { subscriptions.push(String(args.topic)); return {} as T }
      if (name === 'poll_messages') {
        const topic = String(args.topic)
        const drained = broadcasts.splice(0)
        const text = `Messages on topic ${topic}: [${drained.map(b => b.payload).join(' ')}]`
        return { content: [{ text }] } as T
      }
      throw new Error(`unexpected tool ${name}`)
    },
  }
  return { bus, broadcasts, subscriptions }
}

describe('fleet notifications over the gossip bus', () => {
  it('publish seals per member; the subscriber trial-opens exactly its own slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notify-'))
    await writeFile(join(dir, 'fleet-members.json'), JSON.stringify({ version: 1, members: [
      { id: 'm1', name: 'mac', capability: 'cap-mac', scopes: ['tasks', 'inference'], createdAt: 'x' },
      { id: 'm2', name: 'laptop', capability: 'cap-laptop', scopes: ['tasks'], createdAt: 'x' },
    ] }))
    const { bus, subscriptions } = fakeBus()
    const publisher = new FleetPublisher(bus, { serviceName: 'dsh-task-service', membersPath: join(dir, 'fleet-members.json'), operatorCapability: 'cap-operator' })
    await publisher.publish({ id: 7, channel: 'fleet', kind: 'user', sender: 'mac', text: 'secret fleet words', ts: 1 })

    // mac opens its slot; laptop opens its slot; operator opens its slot; a stranger opens NOTHING
    const received: string[] = []
    const subscriber = new FleetSubscriber(bus, { serviceName: 'dsh-task-service', capability: 'cap-laptop', onMessage: m => received.push(m.text) })
    await subscriber.start()
    expect(subscriptions).toContain(chatTopic('dsh-task-service'))
    await (subscriber as unknown as { poll(): Promise<void> }).poll()
    expect(received).toEqual(['secret fleet words'])

    // a stranger (valid mesh member with a random capability) trial-opens nothing
    const strangerSeen: string[] = []
    const stranger = new FleetSubscriber(bus, { serviceName: 'dsh-task-service', capability: 'cap-stranger', onMessage: m => strangerSeen.push(m.text) })
    const republished = fakeBus()
    // republish for the stranger's bus (first bus drained)
    const pub2 = new FleetPublisher(republished.bus, { serviceName: 'dsh-task-service', membersPath: join(dir, 'fleet-members.json'), operatorCapability: 'cap-operator' })
    await pub2.publish({ id: 8, channel: 'fleet', kind: 'user', sender: 'mac', text: 'still secret', ts: 2 })
    await (stranger as unknown as { poll(): Promise<void> }).poll()
    expect(strangerSeen).toEqual([])

    // the operator opens its slot
    const opSeen: string[] = []
    const op = new FleetSubscriber(republished.bus, { serviceName: 'dsh-task-service', capability: 'cap-operator', onMessage: m => opSeen.push(m.text) })
    await (op as unknown as { poll(): Promise<void> }).poll()
    expect(opSeen).toEqual(['still secret'])
    subscriber.stop(); stranger.stop(); op.stop()
  })

  it('payloadsOf parses the Sprintf dump and rejects non-matching text', () => {
    expect(FleetSubscriber.payloadsOf('Messages on topic t/x: [abc def]', 't/x')).toEqual(['abc', 'def'])
    expect(FleetSubscriber.payloadsOf('Messages on topic t/x: []', 't/x')).toEqual([])
    expect(FleetSubscriber.payloadsOf('garbage', 't/x')).toEqual([])
  })
})
