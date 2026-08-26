/**
 * ECIES over X25519 (ECDH -> SHA-256 -> AES-256-GCM) using only node:crypto.
 * Seals a payload to a recipient's ephemeral public key — the delivery
 * mechanism for fleet pairing: approval seals the invite to the joiner's
 * ephemeral key, and only that key can open it.
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'

export interface SealedPayload { ephemeralPublicKey: string; nonce: string; ciphertext: string; tag: string }

function x25519PublicFromJwkX(x: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' })
}

export function generatePairKeys(): { publicKeyX: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('x25519 jwk export missing x')
  return { publicKeyX: jwk.x, privateKey }
}

function sharedKey(privateKey: KeyObject, peerPublicX: string): Buffer {
  const secret = diffieHellman({ privateKey, publicKey: x25519PublicFromJwkX(peerPublicX) })
  return createHash('sha256').update(secret).digest()
}

/** Seal plaintext to a recipient's x25519 public key. */
export function seal(plaintext: string, recipientPublicX: string): SealedPayload {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const key = sharedKey(privateKey, recipientPublicX)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string }
  return {
    ephemeralPublicKey: jwk.x!,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

/** Open a sealed payload with the recipient's private key. Throws on tampering/wrong key. */
export function open(sealed: SealedPayload, privateKey: KeyObject): string {
  const key = sharedKey(privateKey, sealed.ephemeralPublicKey)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}
