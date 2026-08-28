/**
 * Fleet pairing: how a machine that found us through PUBLIC discovery gets
 * the fleet capability without any out-of-band channel. Syncthing model —
 * public rendezvous, human approval, encrypted delivery (ECIES from
 * @morewax/sam-mesh — the crypto lives with the mesh kit, the store with
 * the service).
 *
 * Protocol: joiner generates an ephemeral X25519 keypair + 128-bit request
 * id and calls fleet_pair_request (ungated); operator approves via
 * capability-gated fleet_pair_approve, which SEALS the fleet invite to the
 * requester's key; fleet_pair_poll delivers it exactly once. Strangers can
 * spam requests (TTL + cap) but ids are unguessable, approvals are human,
 * and the sealed payload is ciphertext without the joiner's private key.
 */
import { randomBytes } from 'node:crypto'
import { seal, type SealedPayload } from '@morewax/sam-mesh'
import type { ToolDescriptor } from './tools.js'
import { TaskProtocolError, type JsonObject } from './types.js'

// ─── pairing store ─────────────────────────────────────────────────────────

export interface PairRequest {
  requestId: string
  publicKeyX: string
  label: string
  requestedAt: number
  sealedInvite?: SealedPayload
  approvedBy?: string
}

export interface PairingStoreOptions { ttlMs?: number; maxPending?: number; now?: () => number }

export class PairingStore {
  private readonly requests = new Map<string, PairRequest>()
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly now: () => number

  constructor(options: PairingStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000       // pairing is a live act: 10 minutes
    this.maxPending = options.maxPending ?? 16      // strangers can spam; they cannot flood
    this.now = options.now ?? (() => Date.now())
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, r] of this.requests) if (r.requestedAt < cutoff) this.requests.delete(id)
  }

  /** Ungated: enqueue a request. Returns false when the pending cap is hit. */
  request(requestId: string, publicKeyX: string, label: string): boolean {
    this.sweep()
    if (this.requests.has(requestId)) return true // idempotent re-request
    if (this.requests.size >= this.maxPending) return false
    this.requests.set(requestId, { requestId, publicKeyX, label: label.slice(0, 120), requestedAt: this.now() })
    return true
  }

  /** Gated (operator): what is waiting for approval. */
  pending(): PairRequest[] {
    this.sweep()
    return [...this.requests.values()].filter(r => !r.sealedInvite)
  }

  /** The pending request a handler is about to approve (swept, not sealed). */
  peek(requestId: string): PairRequest | undefined {
    this.sweep()
    const r = this.requests.get(requestId)
    return r && !r.sealedInvite ? r : undefined
  }

  /** Gated (operator): approve = seal the invite to the requester's key. */
  approve(requestId: string, inviteJson: string, approvedBy: string): PairRequest | undefined {
    // (kept sync for the store; the tool handler resolves async inviteFor first)
    this.sweep()
    const r = this.requests.get(requestId)
    if (!r || r.sealedInvite) return undefined
    r.sealedInvite = seal(inviteJson, r.publicKeyX)
    r.approvedBy = approvedBy
    return r
  }

  /** Ungated (joiner): pending → undefined-with-pending marker; approved → sealed, single-use. */
  poll(requestId: string): { state: 'pending' } | { state: 'approved'; sealed: SealedPayload } | { state: 'unknown' } {
    this.sweep()
    const r = this.requests.get(requestId)
    if (!r) return { state: 'unknown' }
    if (!r.sealedInvite) return { state: 'pending' }
    const sealed = r.sealedInvite
    this.requests.delete(requestId) // single-use: the capability is delivered exactly once
    return { state: 'approved', sealed }
  }

  /** Gated (operator): reject/expire a request. */
  reject(requestId: string): boolean { this.sweep(); return this.requests.delete(requestId) }
}

// ─── pairing as a mountable module ──────────────────────────────────────────

interface PairingCapable {
  tools: { register(tool: ToolDescriptor): unknown }
  pairing?: PairingStore | undefined
  pairInviteFor?: ((label: string) => string | Promise<string>) | undefined
}

/** Protocol errors keep the exact pre-module codes/messages (pinned by tests). */
function pairError(code: string, message: string, retryable: boolean): TaskProtocolError {
  return new TaskProtocolError({ code, message, retryable })
}

/** One-time, short-lived invite codes: possession IS the approval. */
export class InviteCodes {
  private readonly codes = new Map<string, { expiresAt: number; scopes?: string[]; note?: string }>()
  constructor(private readonly options: PairingStoreOptions = {}) {}
  private get now(): number { return this.options.now?.() ?? Date.now() }
  private sweep(): void {
    for (const [code, entry] of this.codes) if (entry.expiresAt <= this.now) this.codes.delete(code)
  }
  create(ttlMs = 15 * 60_000, scopes?: string[], note?: string): { code: string; expiresAt: number } {
    this.sweep()
    const code = randomBytes(9).toString('base64url')
    const expiresAt = this.now + ttlMs
    this.codes.set(code, { expiresAt, ...(scopes?.length ? { scopes } : {}), ...(note ? { note } : {}) })
    return { code, expiresAt }
  }
  /** Non-destructive validity check (gate decisions before queuing). */
  peek(code: unknown): boolean {
    if (typeof code !== 'string' || code === '') return false
    this.sweep()
    return this.codes.has(code)
  }

  /** Single-use consume: a valid unexpired code is consumed atomically. */
  consume(code: unknown): { scopes?: string[] } | undefined {
    if (typeof code !== 'string' || code === '') return undefined
    this.sweep()
    const entry = this.codes.get(code)
    if (!entry) return undefined
    this.codes.delete(code)
    return { ...(entry.scopes ? { scopes: entry.scopes } : {}) }
  }
}

/** The five pairing tools. request/poll are open BY DESIGN — see file header. */
export function pairingTools(store: PairingStore, inviteFor: (label: string, scopes?: string[]) => string | Promise<string>, invites?: InviteCodes, inviteOnly = false): ToolDescriptor[] {
  const obj = (required: string[], properties: Record<string, unknown>): Record<string, unknown> =>
    ({ type: 'object', required, properties, additionalProperties: false })
  const requestId = { requestId: { type: 'string', minLength: 1 } }
  return [
    { name: 'fleet_pair_request', description: 'Request to join this fleet (ungated). With a valid one-time inviteCode: instant approval. Otherwise sealed delivery after operator approval.', auth: 'open',
      schema: obj(['requestId', 'publicKey'], { requestId: { type: 'string', minLength: 16 }, publicKey: { type: 'string', minLength: 1 }, label: { type: 'string' }, inviteCode: { type: 'string' } }),
      handler: async (args: JsonObject) => {
        if (typeof args.requestId !== 'string' || args.requestId.length < 16) throw pairError('TASK_PROTOCOL_INVALID_REQUEST', 'requestId must be a random string of at least 16 chars', false)
        if (typeof args.publicKey !== 'string' || !args.publicKey) throw pairError('TASK_PROTOCOL_INVALID_REQUEST', 'publicKey (x25519 jwk x) is required', false)
        if (inviteOnly && invites?.peek(args.inviteCode) !== true) {
          throw pairError('TASK_PAIRING_INVITE_REQUIRED', 'This fleet is invite-only — ask the operator for a one-time invite code', false)
        }
        if (!store.request(args.requestId, args.publicKey, typeof args.label === 'string' ? args.label : 'unknown')) throw pairError('TASK_PAIRING_BUSY', 'Too many pending pair requests — try later', true)
        // Possession of a live one-time code IS the approval: seal + mint
        // immediately, no operator round-trip. A wrong/expired code degrades
        // to the normal pending-request queue (a typo never locks anyone out;
        // in invite-only fleets it was already rejected above). Consumed ONCE
        // here — a busy queue no longer burns the code.
        const invite = invites?.consume(args.inviteCode)
        if (invite) {
          const label = typeof args.label === 'string' && args.label.trim() ? args.label : 'invite-joiner'
          const sealed = store.approve(args.requestId, await inviteFor(label, invite.scopes), 'invite-code')
          if (sealed) return { accepted: true, autoApproved: 'invite-code' }
        }
        return { accepted: true }
      } },
    { name: 'fleet_pair_poll', description: 'Poll a pair request (ungated; single-use once approved)', auth: 'open',
      schema: obj(['requestId'], requestId),
      handler: async (args: JsonObject) => {
        if (typeof args.requestId !== 'string') throw pairError('TASK_PROTOCOL_INVALID_REQUEST', 'requestId is required', false)
        return store.poll(args.requestId)
      } },
    { name: 'fleet_pair_list', description: 'List pending fleet pair requests (capability-gated)', auth: 'operator',
      schema: obj([], {}),
      handler: async () => ({ pending: store.pending() }) },
    { name: 'fleet_pair_approve', description: 'Approve a pair request — seals the fleet invite to the requester (capability-gated)', auth: 'operator',
      schema: obj(['requestId'], { ...requestId, approvedBy: { type: 'string' } }),
      handler: async (args: JsonObject) => {
        if (typeof args.requestId !== 'string') throw pairError('TASK_PROTOCOL_INVALID_REQUEST', 'requestId is required', false)
        const request = store.peek(args.requestId)
        if (!request) throw pairError('TASK_PAIRING_UNKNOWN', 'No pending request with that id (expired, approved, or unknown)', false)
        // Mint first (async), then seal — the invite carries the member capability.
        const invite = await inviteFor(request.label)
        const approved = store.approve(args.requestId, invite, typeof args.approvedBy === 'string' && args.approvedBy.trim() ? args.approvedBy : 'operator')
        if (!approved) throw pairError('TASK_PAIRING_UNKNOWN', 'No pending request with that id (expired, approved, or unknown)', false)
        return { approved: true, requestId: approved.requestId, label: approved.label }
      } },
    { name: 'fleet_pair_reject', description: 'Reject a pending pair request (capability-gated)', auth: 'operator',
      schema: obj(['requestId'], requestId),
      handler: async (args: JsonObject) => ({ rejected: typeof args.requestId === 'string' && store.reject(args.requestId) }) },
    { name: 'fleet_invite_create', description: 'Create a one-time invite code: possession is the approval (operator). Paste into a pair request for instant admission.', auth: 'operator',
      schema: obj([], { ttlMs: { type: 'number' }, scopes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }),
      handler: async (args: JsonObject) => {
        if (invites === undefined) throw pairError('TASK_PAIRING_DISABLED', 'This service does not arm invite codes', false)
        const ttl = typeof args.ttlMs === 'number' && args.ttlMs > 0 && args.ttlMs <= 24 * 60 * 60_000 ? args.ttlMs : 15 * 60_000
        const scopes = Array.isArray(args.scopes) ? args.scopes.filter((s): s is string => typeof s === 'string') : undefined
        return invites.create(ttl, scopes, typeof args.note === 'string' ? args.note : undefined)
      } },
  ]
}

/** Mount fleet pairing on any registry-bearing service. One line, full onboarding. */
export function withPairing<T extends PairingCapable>(service: T, options: { store?: PairingStore; invites?: InviteCodes; inviteOnly?: boolean; inviteFor: (label: string, scopes?: string[]) => string | Promise<string> }): T {
  const store = options.store ?? new PairingStore()
  for (const tool of pairingTools(store, options.inviteFor, options.invites, options.inviteOnly === true)) service.tools.register(tool)
  // Attach so in-process operator surfaces (the web card) share the exact
  // store + invite the mesh tools use — one source, never two.
  service.pairing = store
  service.pairInviteFor = options.inviteFor
  return service
}
