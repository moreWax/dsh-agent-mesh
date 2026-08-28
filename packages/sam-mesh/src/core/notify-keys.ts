/**
 * Deterministic notification keys: a fleet member's X25519 pair derived from
 * their capability. The fleet server computes the SAME public key from the
 * capability it stores, so per-member sealed notifications need zero new key
 * management — and revocation kills decryption with no push (the member's
 * capability is the only thing that ever derived the private half).
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

const SEED_DOMAIN = 'dsh-mesh-chat-notify-v1'

/** X25519 clamping (RFC 7748 §5). */
function clamp(secret: Buffer): Buffer {
  const b = Buffer.from(secret)
  b[0] = (b[0] ?? 0) & 248
  b[31] = (b[31] ?? 0) & 127
  b[31] = (b[31] ?? 0) | 64
  return b
}

/** The member's derived keypair. Same shape as generatePairKeys(). */
export function deriveNotifyKeys(capability: string): { publicKeyX: string; privateKey: KeyObject } {
  if (!capability) throw new Error('deriveNotifyKeys: capability is required')
  const seed = clamp(createHash('sha256').update(SEED_DOMAIN).update(capability).digest())
  // PKCS8 DER for Curve25519: fixed 16-byte prefix + the 32-byte scalar —
  // node derives the public half from it (JWK import would demand both d AND x).
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), seed])
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('x25519 jwk export missing x')
  return { publicKeyX: jwk.x, privateKey }
}

/** The fleet server's half: the member's public key from the stored capability. */
export function deriveNotifyPublicKey(capability: string): string {
  return deriveNotifyKeys(capability).publicKeyX
}
