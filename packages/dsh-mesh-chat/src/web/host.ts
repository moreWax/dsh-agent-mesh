/**
 * dsh-mesh-chat web host: the card's remotes. Fleet channel calls ride the
 * task service's MCP tools through the mesh (member capability injected);
 * DMs call the peer's announced inbox. The LOCAL inbox store is read
 * directly — it lives in this process.
 */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export interface ActionResult { ok: boolean; message?: string; error?: string }
export interface ChatMessageView { id: number; kind: 'user' | 'system'; sender: string; text: string; ts: number; meta?: unknown }
export interface ChatSnapshot {
  fleet: { available: boolean; cursor: number; messages: ChatMessageView[]; error?: string }
  inbox: { serviceName: string; messages: ChatMessageView[] }
}

/** Structural agentMesh face — the seam to @morewax/dsh-agent-mesh without importing it. */
interface AgentMeshFace {
  core: {
    callRemoteTool(input: { peer_id: string; tool_name: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown>
    discoverRemoteServices(input: { type: string; name?: string }): Promise<Array<{ srv_name: string; peer_id?: string }>>
  }
  resolveCallCapability?: () => Promise<string | undefined>
}

function toolPayload<T extends Record<string, unknown>>(result: unknown): T {
  if (typeof result === 'object' && result !== null) {
    const structured = (result as { structuredContent?: unknown }).structuredContent
    if (structured && typeof structured === 'object') return structured as T
    return result as T
  }
  return {} as T
}

export class MeshChatWebHost extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly options: {
      store: { fetch(channel: string, afterId?: number, limit?: number): Array<{ id: number; kind: string; sender: string; text: string; ts: number; meta?: unknown }>; append(channel: string, message: { kind: 'user' | 'system'; sender: string; text: string; meta?: unknown }): { id: number } }
      inboxServiceName?: string
      fleetServiceName?: string
      maxMessageChars?: number
    },
  ) { super(ctx, 'agentMeshChatWeb') }

  private get mesh(): AgentMeshFace { return (this.ctx as unknown as { agentMesh: AgentMeshFace }).agentMesh }

  /** Fleet server candidates: exact name first, then suffix matches —
   *  operator-chosen prefixes ('morewax-dsh-task-service' vs the default).
   *  NOTE: paired members also register their OWN task service under the
   *  fleet's name (a known collision — fleetProfilePatch pins the consumer
   *  row to the fleet name), so callers must TRY candidates in order:
   *  the real fleet server is the one whose chat tools actually answer. */
  private async fleetCandidates(serviceName?: string): Promise<Array<{ peerId: string; service: string }>> {
    const name = serviceName ?? this.options.fleetServiceName ?? 'dsh-task-service'
    const all = await this.mesh.core.discoverRemoteServices({ type: 'mcp' }).catch(() => [])
    const exact = all.filter(s => s.srv_name === name && s.peer_id)
    const fuzzy = all.filter(s => typeof s.srv_name === 'string' && s.srv_name.endsWith('task-service') && s.peer_id && !exact.includes(s))
    return [...exact, ...fuzzy].map(s => ({ peerId: s.peer_id!, service: s.srv_name }))
  }

  /** Snapshot both channels. afterId = last-seen fleet cursor (0 = tail-fetch the recent window). */
  // NOTE: gateway SRC-mode reflection forbids destructured/defaulted/rest
  // parameters on @Remote methods — plain unique identifiers only.
  @Remote("chatSnapshot") async chatSnapshot(afterId: number): Promise<ChatSnapshot> {
    afterId = typeof afterId === "number" ? afterId : 0
    const fleet: ChatSnapshot['fleet'] = { available: false, cursor: afterId, messages: [] }
    const candidates = await this.fleetCandidates()
    if (candidates.length === 0) fleet.error = `no '${this.options.fleetServiceName ?? 'dsh-task-service'}' fleet service visible in the swarm`
    else {
      const capability = await this.mesh.resolveCallCapability?.()
      let lastError = ''
      for (const provider of candidates) {
        try {
          const result = toolPayload<{ messages?: ChatMessageView[] }>(await this.mesh.core.callRemoteTool({
            peer_id: provider.peerId,
            tool_name: `mcp://${provider.service}/chat_fetch`,
            arguments: { ...(afterId > 0 ? { afterId } : {}), limit: 50, ...(capability !== undefined ? { _capability: capability } : {}) },
          }))
          if (Array.isArray(result.messages)) {
            fleet.available = true
            fleet.messages = result.messages
            fleet.cursor = result.messages.length > 0 ? result.messages[result.messages.length - 1]!.id : afterId
            break
          }
          lastError = 'fleet channel unavailable (no member capability?)'
        } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
      }
      if (!fleet.available) fleet.error = lastError || 'fleet channel unavailable (no member capability?)'
    }
    const inbox = { serviceName: this.options.inboxServiceName ?? 'dsh-chat-inbox', messages: this.options.store.fetch('inbox', 0, 50).slice(-50) as ChatMessageView[] }
    return { fleet, inbox }
  }

  /** Send to the fleet channel (member-gated). */
  @Remote("chatSend") async chatSend(text: string): Promise<ActionResult> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: 'empty message' }
    if (trimmed.length > (this.options.maxMessageChars ?? 4000)) return { ok: false, error: 'message too large' }
    const candidates = await this.fleetCandidates()
    if (candidates.length === 0) return { ok: false, error: `no '${this.options.fleetServiceName ?? 'dsh-task-service'}' fleet service visible in the swarm` }
    const capability = await this.mesh.resolveCallCapability?.()
    if (capability === undefined) return { ok: false, error: 'no fleet capability on this machine — join the fleet first' }
    let lastError = ''
    for (const provider of candidates) {
      try {
        await this.mesh.core.callRemoteTool({
          peer_id: provider.peerId,
          tool_name: `mcp://${provider.service}/chat_send`,
          arguments: { text: trimmed, _capability: capability },
        })
        return { ok: true, message: 'sent' }
      } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
    }
    return { ok: false, error: lastError || 'send failed' }
  }

  /** DM a peer by peer id: call its announced inbox service. */
  @Remote("dmSend") async dmSend(peerId: string, text: string): Promise<ActionResult> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: 'empty message' }
    if (!peerId.trim()) return { ok: false, error: 'peer id is required' }
    const inboxName = this.options.inboxServiceName ?? 'dsh-chat-inbox'
    const services = await this.mesh.core.discoverRemoteServices({ type: 'mcp', name: inboxName }).catch(() => [])
    const hit = services.find(s => s.srv_name === inboxName && (s.peer_id ?? '').startsWith(peerId.trim()))
    if (!hit?.peer_id) return { ok: false, error: `no '${inboxName}' visible on that peer (is it online? does it run dsh-mesh-chat?)` }
    const me = `${randomBytes(4).toString('hex')}@local`
    await this.mesh.core.callRemoteTool({
      peer_id: hit.peer_id,
      tool_name: `mcp://${inboxName}/dm_send`,
      arguments: { from: me, text: trimmed },
    })
    // Mirror the sent DM locally so the conversation reads both ways.
    this.options.store.append('inbox', { kind: 'user', sender: `${me} (you)`, text: trimmed })
    return { ok: true, message: 'delivered' }
  }
}
