/**
 * Hardware key distribution: members request a hardware key from the operator
 * (who has a Mac), the operator extracts it on their Mac and delivers it
 * sealed to the requester's ephemeral X25519 key. Same trust model as fleet
 * pairing: requests are open (unguessable ids), fulfillment is operator-gated,
 * delivery is ECIES-sealed and single-use.
 *
 * IMPORTANT: each hardware key represents a device identity. One key per
 * member — distributing the same key to many members presents identical
 * hardware identifiers to Apple from many IPs (flag risk). The operator
 * should extract a fresh key per member when possible.
 */
import { randomBytes } from 'node:crypto'
import { generatePairKeys, seal, open, type SealedPayload } from '@morewax/sam-mesh'
import type { ToolDescriptor } from '../../dsh-agent-mesh/src/tasks/tools.js'
import { TaskProtocolError, type JsonObject } from '../../dsh-agent-mesh/src/tasks/types.js'

const err = (code: string, message: string): TaskProtocolError => new TaskProtocolError({ code, message, retryable: false })

interface KeyRequest { requestId: string; publicKeyX: string; label: string; requestedAt: number; sealed?: SealedPayload }

export function keyTools(): ToolDescriptor[] {
  const requests = new Map<string, KeyRequest>()
  const obj = (required: string[], properties: Record<string, unknown>): Record<string, unknown> =>
    ({ type: 'object', required, properties, additionalProperties: false })

  return [
    { name: 'imessage_key_request', description: 'Request a hardware key from the operator (open; sealed delivery after operator fulfillment)', auth: 'open',
      schema: obj(['requestId', 'publicKey'], { requestId: { type: 'string', minLength: 16 }, publicKey: { type: 'string' }, label: { type: 'string' } }),
      handler: async (args: JsonObject) => {
        const requestId = typeof args.requestId === 'string' ? args.requestId : ''
        const publicKey = typeof args.publicKey === 'string' ? args.publicKey : ''
        if (!requestId || requestId.length < 16) throw err('TASK_PROTOCOL_INVALID_REQUEST', 'requestId must be a random string of at least 16 chars')
        if (!publicKey) throw err('TASK_PROTOCOL_INVALID_REQUEST', 'publicKey (x25519 jwk x) is required')
        requests.set(requestId, { requestId, publicKeyX: publicKey, label: typeof args.label === 'string' ? args.label : 'unknown', requestedAt: Date.now() })
        return { accepted: true }
      } },
    { name: 'imessage_key_poll', description: 'Poll a key request (open; single-use once fulfilled)', auth: 'open',
      schema: obj(['requestId'], { requestId: { type: 'string' } }),
      handler: async (args: JsonObject) => {
        const requestId = typeof args.requestId === 'string' ? args.requestId : ''
        const r = requests.get(requestId)
        if (!r) return { state: 'unknown' }
        if (!r.sealed) return { state: 'pending' }
        const sealed = r.sealed
        requests.delete(requestId)
        return { state: 'fulfilled', sealed }
      } },
    { name: 'imessage_key_requests', description: 'List pending hardware key requests (operator)', auth: 'operator',
      schema: obj([], {}),
      handler: async () => ({ pending: [...requests.values()].filter(r => !r.sealed).map(r => ({ requestId: r.requestId, label: r.label, requestedAt: r.requestedAt })) }) },
    { name: 'imessage_key_fulfill', description: 'Fulfill a hardware key request — seals the hardware key blob to the requester (operator)', auth: 'operator',
      schema: obj(['requestId', 'hardwareKeyBlob'], { requestId: { type: 'string' }, hardwareKeyBlob: { type: 'string', minLength: 16 } }),
      handler: async (args: JsonObject) => {
        const requestId = typeof args.requestId === 'string' ? args.requestId : ''
        const blob = typeof args.hardwareKeyBlob === 'string' ? args.hardwareKeyBlob : ''
        if (!requestId) throw err('TASK_PROTOCOL_INVALID_REQUEST', 'requestId is required')
        if (blob.length < 16) throw err('TASK_PROTOCOL_INVALID_REQUEST', 'hardwareKeyBlob is required (base64 from the ExtractKey tool)')
        const r = requests.get(requestId)
        if (!r || r.sealed) throw err('TASK_KEY_REQUEST_UNKNOWN', 'No pending request with that id')
        r.sealed = seal(blob, r.publicKeyX)
        return { fulfilled: true, requestId, label: r.label }
      } },
  ]
}

export { generatePairKeys, open }
