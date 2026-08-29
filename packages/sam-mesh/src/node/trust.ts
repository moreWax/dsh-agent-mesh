/**
 * Runtime trust-staleness detection: count DISTINCT peers that rejected OUR
 * catalog fetch in a log tail. One or two rejections can be THEIR staleness;
 * three or more distinct peers rejecting us is OUR stale identity (hub key
 * rotation missed). Pure — same verdict feeds doctor and the manager's
 * runtime watcher.
 */
const CATALOG_REJECT = /catalog fetch from (\S+) failed: auth rejected/g

export function trustRejections(logTail: string): { distinctPeers: number } {
  const peers = new Set<string>()
  for (const match of logTail.matchAll(CATALOG_REJECT)) {
    if (match[1]) peers.add(match[1].slice(0, 20))
  }
  return { distinctPeers: peers.size }
}

export function isTrustStale(logTail: string): boolean {
  return trustRejections(logTail).distinctPeers >= 3
}
