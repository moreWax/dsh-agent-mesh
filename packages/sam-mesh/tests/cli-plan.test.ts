import { describe, expect, it } from 'vitest'
import { formatMintBlock, nextJoinStep } from '../src/cli/plan.js'

describe('nextJoinStep', () => {
  it('offers install when the binary is missing — interactive or not', () => {
    expect(nextJoinStep({ installed: false, enrolled: false }, true)).toEqual({ action: 'install-offer' })
    expect(nextJoinStep({ installed: false, enrolled: false }, false)).toEqual({ action: 'install-offer' })
  })

  it('refuses an already-enrolled machine before anything else', () => {
    expect(nextJoinStep({ installed: true, enrolled: true }, true)).toEqual({ action: 'already-enrolled' })
  })

  it('proceeds when installed and unenrolled', () => {
    expect(nextJoinStep({ installed: true, enrolled: false }, false)).toEqual({ action: 'join' })
  })
})

describe('formatMintBlock', () => {
  const block = formatMintBlock('sam-bt-abc123', 'http://192.168.50.17:8480')

  it('stores the token as a 0600 file, never inline in the join command', () => {
    expect(block).toContain("printf '%s' 'sam-bt-abc123' > ~/sam-join-token && chmod 600 ~/sam-join-token")
    expect(block).toContain('--bootstrap-token-path ~/sam-join-token')
    expect(block).not.toContain('--bootstrap-token sam-bt-abc123')
  })

  it('points the join at the same hub the token was minted on', () => {
    expect(block).toContain('--control-plane http://192.168.50.17:8480')
  })

  it('names the npx entry so no clone is needed once published', () => {
    expect(block).toContain('npx @morewax/sam-mesh node join')
  })
})
