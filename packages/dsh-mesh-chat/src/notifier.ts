/**
 * Mesh-native chat notifications: GossipSub broadcast with per-member sealed
 * fan-out. The fleet server publishes one envelope per chat message; each
 * member's slot is ECIES-sealed to the X25519 key DERIVED FROM their
 * capability (sam-mesh deriveNotifyKeys) — gossip topics are mesh-wide, so
 * plaintext never leaves the fleet. Revocation kills decryption with zero
 * push: the registry file is the recipient list, and a revoked member's
 * capability derives nothing new.
 *
 * Consumption rides the node's own MCP tools (subscribe_topic/poll_messages —
 * the "MCP notifications" path): the dsh host polls its LOCAL node and
 * trial-opens slots with its derived key (wrong slots fail the GCM tag).
 */
import { readFile, stat } from 'node:fs/promises'
import { seal, open, deriveNotifyKeys, deriveNotifyPublicKey, type SealedPayload } from '@morewax/sam-mesh'
import type { ChatMessage } from './store.js'

export interface NotifyEnvelope {
  kind: 'dsh-chat-event'
  service: string
  cursor: number
  sealed: Record<string, SealedPayload>
}

/** The bus face the notifier needs — the SamClient's tool surface, structurally. */
export interface NotifyBus {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>
}

/** mtime-cached member-file reader (the shared registry, read-only). */
export class MemberFileView {
  private cache: { mtimeMs: number; members: Array<{ id: string; name: string; capability: string; scopes: string[] }> } | undefined
  constructor(private readonly path: string) {}
  async members(): Promise<Array<{ id: string; name: string; capability: string; scopes: string[] }>> {
    let mtimeMs = 0
    try { mtimeMs = (await stat(this.path)).mtimeMs } catch { /* missing = empty */ }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.members
    let members: Array<{ id: string; name: string; capability: string; scopes: string[] }> = []
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { members?: Array<{ id: string; name: string; capability: string; scopes: string[] }> }
      if (Array.isArray(parsed.members)) members = parsed.members
    } catch { /* unreadable = empty (fail closed) */ }
    this.cache = { mtimeMs, members }
    return members
  }
}

export interface PublisherOptions {
  serviceName: string
  membersPath: string
  /** The operator shared capability, sealed to as a recipient while legacy holds. */
  operatorCapability?: string | undefined
  log?: (line: string) => void
}

export function chatTopic(serviceName: string): string {
  return `dsh-chat/fleet/${serviceName}`
}

export class FleetPublisher {
  private readonly members: MemberFileView
  constructor(private readonly bus: NotifyBus, private readonly options: PublisherOptions) {
    this.members = new MemberFileView(options.membersPath)
  }
  /** Seal a chat message to every current member (+ operator) and broadcast. Never throws — notifications must not break the chat path. */
  async publish(message: ChatMessage): Promise<void> {
    try {
      const members = await this.members.members()
      this.options.log?.(`publish: ${members.length} member slot(s)${this.options.operatorCapability ? ' + operator' : ''} for message ${message.id}`)
      const sealed: Record<string, SealedPayload> = {}
      const payload = JSON.stringify(message)
      for (const member of members) sealed[member.id] = seal(payload, deriveNotifyPublicKey(member.capability))
      if (this.options.operatorCapability) sealed.operator = seal(payload, deriveNotifyPublicKey(this.options.operatorCapability))
      if (Object.keys(sealed).length === 0) return
      const envelope: NotifyEnvelope = { kind: 'dsh-chat-event', service: this.options.serviceName, cursor: message.id, sealed }
      // base64url the compact JSON: poll_messages joins entries with spaces,
      // so payloads must be whitespace-free.
      await this.bus.callTool('mesh_pubsub_broadcast', { topic: chatTopic(this.options.serviceName), payload: Buffer.from(JSON.stringify(envelope)).toString('base64url') })
    } catch (error) { this.options.log?.(`notify publish failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
}

export interface SubscriberOptions {
  serviceName: string
  /** The local fleet capability — derives the private half for trial-open. */
  capability: string
  pollIntervalMs?: number
  onMessage: (message: ChatMessage) => void
  log?: (line: string) => void
}

export class FleetSubscriber {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly keys: { privateKey: Parameters<typeof open>[1] }
  constructor(private readonly bus: NotifyBus, private readonly options: SubscriberOptions) {
    this.keys = deriveNotifyKeys(options.capability)
  }
  async start(): Promise<void> {
    await this.bus.callTool('subscribe_topic', { topic: chatTopic(this.options.serviceName) })
    this.timer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? 1500)
    this.timer.unref?.()
  }
  stop(): void { if (this.timer) clearInterval(this.timer) }
  /** Parse the Sprintf dump: "Messages on topic <t>: [a b c]" → payloads. */
  static payloadsOf(text: string, topic: string): string[] {
    const prefix = `Messages on topic ${topic}: [`
    if (!text.startsWith(prefix) || !text.endsWith(']')) return []
    const inner = text.slice(prefix.length, -1).trim()
    return inner === '' ? [] : inner.split(' ')
  }
  private async poll(): Promise<void> {
    try {
      const result = await this.bus.callTool<{ content?: Array<{ text?: string }> }>('poll_messages', { topic: chatTopic(this.options.serviceName) })
      const text = result?.content?.[0]?.text ?? ''
      for (const token of FleetSubscriber.payloadsOf(text, chatTopic(this.options.serviceName))) {
        let envelope: NotifyEnvelope
        try { envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) } catch { continue }
        if (envelope?.kind !== 'dsh-chat-event') continue
        for (const sealed of Object.values(envelope.sealed ?? {})) {
          try {
            const message = JSON.parse(open(sealed, this.keys.privateKey)) as ChatMessage
            this.options.onMessage(message)
            break // exactly one slot is ours
          } catch { /* not our slot */ }
        }
      }
    } catch (error) { this.options.log?.(`notify poll failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
