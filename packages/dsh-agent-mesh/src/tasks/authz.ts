/**
 * Authorization as a verifier CHAIN, not service code. The HTTP edge runs
 * every registered authorizer against the tool's declared auth; services
 * mount the chain instead of inheriting gate code, and new authz models
 * (scoped tokens, biscuits, rate limits) plug in without touching services.
 */
import { timingSafeEqual } from 'node:crypto'
import type { JsonObject } from './types.js'
import type { ToolDescriptor } from './tools.js'

export type Verdict = { allow: true; member?: string } | { allow: false; message: string }
const ALLOW: Verdict = { allow: true }

/** Credentials extracted from the transport edge — never reach tool handlers. */
export interface AuthContext { capability?: string | undefined }

export interface Authorizer {
  name: string
  /** Sync or async — the chain awaits either. */
  check(tool: ToolDescriptor, args: JsonObject, ctx: AuthContext): Verdict | Promise<Verdict>
}

export async function runAuthorizers(authorizers: Authorizer[], tool: ToolDescriptor, args: JsonObject, ctx: AuthContext): Promise<Verdict> {
  // Denial short-circuits; the first allow that identifies a member carries
  // its attribution out (the bare ALLOW constant would drop it).
  let attributed: Verdict = ALLOW
  for (const authorizer of authorizers) {
    const verdict = await authorizer.check(tool, args, ctx)
    if (!verdict.allow) return verdict
    if (attributed === ALLOW && verdict.member) attributed = verdict
  }
  return attributed
}

/**
 * Fleet capability: non-open tools must present the shared secret.
 * Missing and wrong are indistinguishable — no oracle about which failed.
 */
export class CapabilityAuthorizer implements Authorizer {
  readonly name = 'capability'
  constructor(private readonly secret: string) {}
  check(tool: ToolDescriptor, _args: JsonObject, ctx: AuthContext): Verdict {
    if (tool.auth === 'open') return ALLOW
    const presented = ctx.capability ?? ''
    const a = Buffer.from(presented); const b = Buffer.from(this.secret)
    if (a.length === b.length && a.length > 0 && timingSafeEqual(a, b)) return ALLOW
    return { allow: false, message: 'capability required' }
  }
}

/**
 * Per-member capabilities: the presented secret identifies a fleet member
 * (or the operator via the legacy shared capability). Enforces tool-level
 * scope — 'operator' tools need the operator credential, 'capability' tools
 * need the owning scope — and reports the member for attribution.
 */
export class MemberAuthorizer implements Authorizer {
  readonly name = 'members'
  constructor(
    private readonly resolveMembers: () => Promise<readonly { capability: string; name: string; scopes: readonly string[] }[]>,
    private readonly operatorSecret: string | undefined,
  ) {}
  async check(tool: ToolDescriptor, _args: JsonObject, ctx: AuthContext): Promise<Verdict> {
    if (tool.auth === 'open') return ALLOW
    const presented = ctx.capability ?? ''
    const members = await this.resolveMembers()
    for (const member of members) {
      const a = Buffer.from(presented); const b = Buffer.from(member.capability)
      if (a.length === b.length && a.length > 0 && timingSafeEqual(a, b)) {
        if (tool.auth === 'operator') return { allow: false, message: 'operator capability required' }
        // Scope enforcement: 'capability' tools default to the owning scope;
        // a tool may declare a stricter one (requiredScopes).
        const required = tool.requiredScopes ?? ['tasks']
        if (!required.some(scope => member.scopes.includes(scope))) return { allow: false, message: 'capability required' }
        return { allow: true, member: member.name }
      }
    }
    if (this.operatorSecret) {
      const a = Buffer.from(presented); const b = Buffer.from(this.operatorSecret)
      if (a.length === b.length && a.length > 0 && timingSafeEqual(a, b)) return { allow: true, member: 'operator' }
    }
    return { allow: false, message: 'capability required' }
  }
}

/**
 * Fleet-facing tool allowlist: caps what the fleet can even ask for. Open
 * tools (pairing discovery) stay reachable; a configured allowlist that does
 * not name a gated tool denies it — the blast radius of a leaked capability.
 */
export class ToolAllowlistAuthorizer implements Authorizer {
  readonly name = 'tool-allowlist'
  constructor(private readonly allow: readonly string[]) {}
  check(tool: ToolDescriptor): Verdict {
    return tool.auth === 'open' || this.allow.includes(tool.name) ? ALLOW : { allow: false, message: 'tool not permitted for fleet use' }
  }
}

/** Extract transport credentials out of tool arguments (returns clean args). */
export function extractCredentials(args: JsonObject): { args: JsonObject; ctx: AuthContext } {
  const { _capability, ...clean } = args
  return { args: clean, ctx: { ...(typeof _capability === 'string' ? { capability: _capability } : {}) } }
}
