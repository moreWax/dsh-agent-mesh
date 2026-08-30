/**
 * Fleet health beacon: the operator-as-emitter pattern. The hub does not emit
 * health events (google/sam#325), so the always-on fleet operator probes in
 * ONE place and broadcasts signed state to the fleet — members never probe.
 *
 * Two event classes on one stream:
 * - TRANSITIONS: hub trust degraded ↔ healthy (emitted immediately)
 * - HEARTBEAT: steady pulse (silence = operator unreachable)
 *
 * Authenticity: per-member ECIES fan-out (registry possession = write
 * authority, capability-derived keys = read authority), same as chat
 * notifications. Gossip topics are open-write, but a stranger cannot seal a
 * valid payload to a member without the member's capability.
 */
import { trustRejections } from '@morewax/sam-mesh/node'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { NotifyBus } from './notifier.js'
import { FleetPublisher } from './notifier.js'
import type { ChatMessage } from './store.js'

export interface FleetHealth {
  kind: 'dsh-fleet-health'
  hubConsistent: boolean
  rejectionCount: number
  operatorPeer?: string
  ts: number
}

export function healthTopic(serviceName: string): string {
  return `dsh-chat/health/${serviceName}`
}

/** Probe local trust the same way doctor does: distinct peers rejecting our catalog fetch in the node log tail. */
export async function probeTrust(dataDir?: string): Promise<{ hubConsistent: boolean; rejectionCount: number }> {
  const dir = dataDir ?? join(homedir(), '.config', 'sam-mesh')
  const log = await readFile(join(dir, 'sam-node.log'), 'utf8').catch(() => '')
  const { distinctPeers } = trustRejections(log.slice(-16_384))
  return { hubConsistent: distinctPeers < 3, rejectionCount: distinctPeers }
}

export interface HealthBeaconOptions {
  serviceName: string
  publisher: FleetPublisher
  bus: NotifyBus
  dataDir?: string
  /** Steady heartbeat cadence (default 5 min); transitions always emit immediately. */
  heartbeatMs?: number
  probeMs?: number
  onTransition?: (healthy: boolean, rejectionCount: number) => void
  log?: (line: string) => void
}

/**
 * The operator's beacon: probes trust on an interval, emits on transitions
 * (immediately) and heartbeats (cadence). Returns a stop function.
 */
export function startHealthBeacon(options: HealthBeaconOptions): () => void {
  const heartbeatMs = options.heartbeatMs ?? 5 * 60_000
  const probeMs = options.probeMs ?? 60_000
  const log = options.log ?? (() => {})
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let lastHealthy: boolean | undefined
  let lastEmit = 0

  const emit = async (healthy: boolean, rejectionCount: number): Promise<void> => {
    lastEmit = Date.now()
    const health: FleetHealth = { kind: 'dsh-fleet-health', hubConsistent: healthy, rejectionCount, ts: Date.now() }
    const message = { id: 0, channel: 'fleet-health', kind: 'system' as const, sender: 'health-beacon', text: JSON.stringify(health), ts: health.ts }
    await options.publisher.publish(message as unknown as ChatMessage, healthTopic(options.serviceName))
  }

  const tick = async (): Promise<void> => {
    try {
      const { hubConsistent, rejectionCount } = await probeTrust(options.dataDir)
      if (lastHealthy === undefined) {
        lastHealthy = hubConsistent
        await emit(hubConsistent, rejectionCount) // initial state = members learn it on boot
        return
      }
      if (hubConsistent !== lastHealthy) {
        lastHealthy = hubConsistent
        options.onTransition?.(hubConsistent, rejectionCount)
        await emit(hubConsistent, rejectionCount)
        return
      }
      if (Date.now() - lastEmit >= heartbeatMs) await emit(hubConsistent, rejectionCount)
    } catch (error) { log(`health beacon tick failed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  void tick()
  timer = setInterval(() => void tick(), probeMs)
  timer.unref?.()
  return () => { stopped = true; if (timer) clearInterval(timer) }
}

/** Subscriber-side view: the latest beacon state, or undefined if none yet. */
export interface HealthState { hubConsistent: boolean; rejectionCount: number; ts: number }

/** Parse a chat message into a health update, when it is one. */
export function healthOf(message: { channel?: string; sender?: string; text?: string }): FleetHealth | undefined {
  if (message.channel !== 'fleet-health' && message.sender !== 'health-beacon') return undefined
  try {
    const parsed = JSON.parse(message.text ?? '') as FleetHealth
    return parsed.kind === 'dsh-fleet-health' ? parsed : undefined
  } catch { return undefined }
}
