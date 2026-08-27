/**
 * Per-member fleet capabilities: one secret per approved member, a local
 * registry, and revocation that propagates as fast as the file is re-read.
 *
 * Doctrine shift (from one shared bearer): the shared capability becomes the
 * OPERATOR credential (whoever holds it administers the fleet); members get
 * their own minted capability with explicit scopes. A leaked member
 * capability is revoked by deleting one line — no re-pairing of anyone else —
 * and every gated call can be attributed to a member.
 *
 * Registry file: ~/.config/sam-mesh/fleet-members.json (0600). Loaded with an
 * mtime cache so revocation takes effect on the NEXT CALL without a restart.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

/** What a member may do. 'admin' is operator-equivalent and is never granted through pairing. */
export type FleetScope = 'tasks' | 'inference' | 'admin'

export interface FleetMember {
  id: string
  name: string
  capability: string
  scopes: FleetScope[]
  createdAt: string
  note?: string
}

export interface MemberIdentity {
  member: string
  scopes: FleetScope[]
  operator: boolean
}

export function defaultMembersPath(): string {
  return `${homedir()}/.config/sam-mesh/fleet-members.json`
}

/** 48-hex member secret, same shape as the operator capability. */
export function mintMemberCapability(): string {
  return randomBytes(24).toString('hex')
}

export interface FleetMemberRegistryOptions {
  now?: () => Date
  /** Test seam for the mtime cache. */
  stat?: (path: string) => Promise<{ mtimeMs: number }>
}

interface RegistryFile { version: 1; members: FleetMember[] }

/**
 * The registry deliberately keeps the raw capabilities on disk (0600, same
 * trust boundary as the operator credential itself): the gate must compare
 * presented secrets, so a digest-only store would only move the problem.
 */
export class FleetMemberRegistry {
  private readonly path: string
  private readonly now: () => Date
  private readonly stat: (path: string) => Promise<{ mtimeMs: number }>
  private cache: { mtimeMs: number; members: FleetMember[] } | undefined
  private digests: Map<string, string> | undefined

  constructor(path: string = defaultMembersPath(), options: FleetMemberRegistryOptions = {}) {
    this.path = path
    this.now = options.now ?? (() => new Date())
    this.stat = options.stat ?? (p => stat(p))
  }

  /** Current members (mtime-cached; a missing file is an empty fleet). */
  async list(): Promise<readonly FleetMember[]> {
    return (await this.load()).members
  }

  /** Timing-safe identification of a presented capability: member hit, or operator when it matches the shared secret. */
  async identify(presented: string | undefined, operatorSecret: string | undefined): Promise<MemberIdentity | undefined> {
    if (!presented) return undefined
    if (operatorSecret) {
      const a = createHash('sha256').update(presented).digest()
      const b = createHash('sha256').update(operatorSecret).digest()
      if (timingSafeEqual(a, b)) return { member: 'operator', scopes: ['tasks', 'inference', 'admin'], operator: true }
    }
    if (!this.digests) await this.load()
    const digest = createHash('sha256').update(presented).digest('hex')
    const member = (await this.list()).find(m => {
      const known = this.digests!.get(m.id)
      return known !== undefined && known === digest
    })
    if (!member) return undefined
    return { member: member.name, scopes: member.scopes, operator: member.scopes.includes('admin') }
  }

  /** Mint + persist a member. Returns the stored record. */
  async add(name: string, scopes: FleetScope[], note?: string): Promise<FleetMember> {
    const { members } = await this.load()
    const member: FleetMember = {
      id: randomBytes(8).toString('hex'),
      name: name.trim() || `member-${members.length + 1}`,
      capability: mintMemberCapability(),
      scopes: scopes.includes('admin') ? scopes.filter(s => s !== 'admin') : scopes,
      createdAt: this.now().toISOString(),
      ...(note ? { note } : {}),
    }
    members.push(member)
    await this.save({ version: 1, members })
    return member
  }

  /** Remove a member; their capability dies on the next gated call. */
  async revoke(id: string): Promise<boolean> {
    const { members } = await this.load()
    const next = members.filter(m => m.id !== id)
    if (next.length === members.length) return false
    await this.save({ version: 1, members: next })
    return true
  }

  private async load(): Promise<{ mtimeMs: number; members: FleetMember[] }> {
    let mtimeMs = 0
    try { mtimeMs = (await this.stat(this.path)).mtimeMs } catch { /* missing file = empty fleet */ }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache
    let members: FleetMember[] = []
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as RegistryFile
      if (Array.isArray(parsed?.members)) members = parsed.members.filter(m => typeof m?.capability === 'string' && typeof m?.name === 'string')
    } catch { /* unreadable file = empty fleet (fail closed), never a crash */ }
    this.digests = new Map(members.map(m => [m.id, createHash('sha256').update(m.capability).digest('hex')] as const))
    this.cache = { mtimeMs, members }
    return this.cache
  }

  /** Atomic persist (tmp + rename) with 0600. */
  private async save(file: RegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.path)
    this.cache = undefined
    this.digests = undefined
  }
}

