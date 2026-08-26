import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bboltGet, hasMeshIdentity } from '../src/node/bbolt.js'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

describe('bbolt live-page reader', () => {
  it('an enrolled store has a non-empty identity biscuit', () => {
    const db = fixture('agent-enrolled.db')
    expect(hasMeshIdentity(db)).toBe(true)
    expect(bboltGet(db, 'identity', 'identity_biscuit')!.length).toBeGreaterThan(100)
  })

  it('a reset store reads as unenrolled even though stale bytes remain in the file', () => {
    const db = fixture('agent-reset.db')
    // the stale control-plane URL really is still in the bytes (freelist):
    expect(db.includes(Buffer.from('http://'))).toBe(true)
    // but the LIVE tree says unenrolled:
    expect(hasMeshIdentity(db)).toBe(false)
  })

  it('unknown keys and buckets read as absent', () => {
    const db = fixture('agent-enrolled.db')
    expect(bboltGet(db, 'identity', 'nope')).toBeNull()
    expect(bboltGet(db, 'no-such-bucket', 'identity_biscuit')).toBeNull()
  })

  it('garbage input never throws', () => {
    expect(hasMeshIdentity(Buffer.alloc(0))).toBe(false)
    expect(hasMeshIdentity(Buffer.from('not a database at all'))).toBe(false)
    expect(hasMeshIdentity(Buffer.alloc(100000, 7))).toBe(false)
  })
})
