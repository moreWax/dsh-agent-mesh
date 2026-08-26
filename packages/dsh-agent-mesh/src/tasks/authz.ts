/**
 * Authorization as a verifier CHAIN, not service code. The HTTP edge runs
 * every registered authorizer against the tool's declared auth; services
 * mount the chain instead of inheriting gate code, and new authz models
 * (scoped tokens, biscuits, rate limits) plug in without touching services.
 */
import { timingSafeEqual } from 'node:crypto'
import type { JsonObject } from './types.js'
import type { ToolDescriptor } from './tools.js'

export type Verdict = { allow: true } | { allow: false; message: string }
const ALLOW: Verdict = { allow: true }

/** Credentials extracted from the transport edge — never reach tool handlers. */
export interface AuthContext { capability?: string | undefined }

export interface Authorizer {
  name: string
  check(tool: ToolDescriptor, args: JsonObject, ctx: AuthContext): Verdict
}

export function runAuthorizers(authorizers: Authorizer[], tool: ToolDescriptor, args: JsonObject, ctx: AuthContext): Verdict {
  for (const authorizer of authorizers) {
    const verdict = authorizer.check(tool, args, ctx)
    if (!verdict.allow) return verdict
  }
  return ALLOW
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

/** Extract transport credentials out of tool arguments (returns clean args). */
export function extractCredentials(args: JsonObject): { args: JsonObject; ctx: AuthContext } {
  const { _capability, ...clean } = args
  return { args: clean, ctx: { ...(typeof _capability === 'string' ? { capability: _capability } : {}) } }
}
