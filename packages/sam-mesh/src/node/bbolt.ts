/**
 * Minimal read-only bbolt reader — just enough to answer "does bucket B hold
 * a non-empty value for key K?" against a sam-node agent.db.
 *
 * Why this exists: enrollment detection used to byte-scan the store for a
 * control-plane URL, but `sam-node reset` deletes keys only from LIVE pages
 * while bbolt's freelist retains stale copies — so the scan false-positives
 * on reset machines and the auto-enrollment flow never fires. The ground
 * truth is the live B+tree, which is what this walks. Read-only, no locking:
 * detection nearly always runs while the node is stopped.
 *
 * Format reference: github.com/etcd-io/bbolt — page header
 * {id u64, flags u16, count u16, overflow u32}, meta at pages 0/1.
 */

const MAGIC = 0xed0cdaed
const VERSION = 2
const BRANCH = 0x01
const LEAF = 0x02
const PAGE_HEADER = 16
const CANDIDATE_PAGE_SIZES = [4096, 8192, 16384, 32768, 65536]

interface Meta { pageSize: number; rootPgid: bigint; txid: bigint }

function readMeta(data: Buffer, pageOff: number): Meta | null {
  if (pageOff + PAGE_HEADER + 56 > data.length) return null
  const m = pageOff + PAGE_HEADER
  if (data.readUInt32LE(m) !== MAGIC || data.readUInt32LE(m + 4) !== VERSION) return null
  const pageSize = data.readUInt32LE(m + 8)
  if (!CANDIDATE_PAGE_SIZES.includes(pageSize)) return null
  return {
    pageSize,
    rootPgid: data.readBigUInt64LE(m + 16), // root bucket: root pgid (skip sequence at +24)
    txid: data.readBigUInt64LE(m + 48),
  }
}

function liveMeta(data: Buffer): Meta | null {
  const metas: Meta[] = []
  for (const size of CANDIDATE_PAGE_SIZES) {
    const m0 = readMeta(data, 0)
    if (!m0) return null
    const m1 = readMeta(data, m0.pageSize) // page 1 sits one pageSize in
    for (const m of [m0, m1]) if (m) metas.push(m)
    break
  }
  if (metas.length === 0) return null
  return metas.reduce((a, b) => (b.txid > a.txid ? b : a))
}

interface Page { flags: number; count: number; off: number }

function pageAt(data: Buffer, pageSize: number, pgid: bigint): Page | null {
  const off = Number(pgid) * pageSize
  if (off + PAGE_HEADER > data.length) return null
  return { flags: data.readUInt16LE(off + 8), count: data.readUInt16LE(off + 10), off }
}

function keyAt(data: Buffer, elemOff: number): Buffer {
  const pos = data.readUInt32LE(elemOff + 4)
  const ksize = data.readUInt32LE(elemOff + 8)
  return data.subarray(elemOff + pos, elemOff + pos + ksize)
}

/** Walk a B+tree rooted at pgid; returns the value for key, or null. */
function find(data: Buffer, pageSize: number, pgid: bigint, key: Buffer, depth = 0): Buffer | null {
  if (depth > 32) return null // corrupt or cyclic
  const page = pageAt(data, pageSize, pgid)
  if (!page) return null
  if (page.flags & LEAF) {
    for (let i = 0; i < page.count; i++) {
      const elem = page.off + PAGE_HEADER + i * 16 // leaf element = 16 bytes
      if (keyAt(data, elem).equals(key)) {
        const vsize = data.readUInt32LE(elem + 12)
        const ksize = data.readUInt32LE(elem + 8)
        const pos = data.readUInt32LE(elem + 4)
        return data.subarray(elem + pos + ksize, elem + pos + ksize + vsize)
      }
    }
    return null
  }
  if (page.flags & BRANCH) {
    // branch element = pos u32, ksize u32, pgid u64 (16 bytes); descend to
    // the last child whose key <= target.
    let child: bigint | null = null
    for (let i = 0; i < page.count; i++) {
      const elem = page.off + PAGE_HEADER + i * 16
      if (keyAt(data, elem).compare(key) <= 0) child = data.readBigUInt64LE(elem + 8)
      else break
    }
    return child === null ? null : find(data, pageSize, child, key, depth + 1)
  }
  return null
}

/** Read a key from a named bucket. Returns null when absent or unreadable. */
export function bboltGet(data: Buffer, bucket: string, key: string): Buffer | null {
  const meta = liveMeta(data)
  if (!meta) return null
  const bucketVal = find(data, meta.pageSize, meta.rootPgid, Buffer.from(bucket, 'utf8'))
  if (!bucketVal || bucketVal.length < 16) return null
  const rootPgid = bucketVal.readBigUInt64LE(0)
  if (rootPgid === 0n) {
    // Inline bucket: a full leaf page is embedded after the 16-byte header.
    const inline = Buffer.concat([bucketVal.subarray(16), Buffer.alloc(0)])
    const page: Page = { flags: inline.readUInt16LE(8), count: inline.readUInt16LE(10), off: 0 }
    if (!(page.flags & LEAF)) return null
    for (let i = 0; i < page.count; i++) {
      const elem = PAGE_HEADER + i * 16
      const pos = inline.readUInt32LE(elem + 4)
      const ksize = inline.readUInt32LE(elem + 8)
      if (inline.subarray(elem + pos, elem + pos + ksize).equals(Buffer.from(key, 'utf8'))) {
        const vsize = inline.readUInt32LE(elem + 12)
        return inline.subarray(elem + pos + ksize, elem + pos + ksize + vsize)
      }
    }
    return null
  }
  return find(data, meta.pageSize, rootPgid, Buffer.from(key, 'utf8'))
}

/** sam-node's own enrollment predicate: identity/identity_biscuit non-empty. */
export function hasMeshIdentity(storeBytes: Buffer): boolean {
  const v = bboltGet(storeBytes, 'identity', 'identity_biscuit')
  return v !== null && v.length > 0
}

/** The hub a store is enrolled on (control_plane_url from the LIVE tree). */
export function readEnrolledHub(storeBytes: Buffer): string | null {
  const v = bboltGet(storeBytes, 'identity', 'control_plane_url')
  if (!v || v.length === 0) return null
  const s = v.toString('utf8')
  return s.startsWith('http') ? s : null
}
