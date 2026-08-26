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
import { seal, type SealedPayload } from '@morewax/sam-mesh'

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

  /** Gated (operator): approve = seal the invite to the requester's key. */
  approve(requestId: string, inviteJson: string, approvedBy: string): PairRequest | undefined {
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
