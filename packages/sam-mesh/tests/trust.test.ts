import { describe, expect, it } from 'vitest'
import { isTrustStale, trustRejections } from '../src/node/trust.js'

const reject = (peer: string) => `[Discovery] catalog fetch from ${peer} failed: auth rejected by ${peer}: authorization failed`

describe('runtime trust detection', () => {
  it('counts distinct rejecting peers, not raw lines', () => {
    const log = [reject('12D3KooWAAAA1111'), reject('12D3KooWAAAA1111'), reject('12D3KooWBBBB2222')].join('\n')
    expect(trustRejections(log).distinctPeers).toBe(2)
    expect(isTrustStale(log)).toBe(false)
  })
  it('stale at 3+ distinct peers rejecting our fetches', () => {
    const log = [reject('12D3KooWAAAA1111'), reject('12D3KooWBBBB2222'), reject('12D3KooWCCCC3333')].join('\n')
    expect(isTrustStale(log)).toBe(true)
  })
  it('ignores unrelated failures and other peers\' auth traffic', () => {
    expect(isTrustStale('[Auth] AuthZ Denied 12D3KooWZZZZ9999: biscuit: invalid signature\n[Discovery] FindProvidersByType returned 7 peers')).toBe(false)
    expect(isTrustStale('catalog fetch from 12D3KooWAAAA1111 failed: failed to dial: all dials failed')).toBe(false)
  })
})
