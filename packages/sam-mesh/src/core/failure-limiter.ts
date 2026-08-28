/**
 * Sliding-window denial counter: cheap flood control at authorization edges.
 * A wrong/leaked token is deniable forever, but without throttling it is
 * ALSO floodable forever — each denial costs a log line and (at the service)
 * an authorizer pass. Past the limit the edge answers 403 immediately and
 * logs sparsely.
 */
import { createHash } from 'node:crypto'

export interface FailureLimiterOptions {
  /** Denials allowed per window before throttling (default 20). */
  perWindow?: number
  /** Window length in ms (default 60s). */
  windowMs?: number
  /** Log every Nth throttled denial (default 50). */
  logEvery?: number
}

export class FailureLimiter {
  private readonly perWindow: number
  private readonly windowMs: number
  private readonly logEvery: number
  private readonly hits = new Map<string, number[]>()
  private readonly throttled = new Map<string, number>()
  constructor(options: FailureLimiterOptions = {}) {
    this.perWindow = options.perWindow ?? 20
    this.windowMs = options.windowMs ?? 60_000
    this.logEvery = options.logEvery ?? 50
  }
  /** Key a credential without logging it: digest prefix. */
  static keyOf(credential: string | undefined): string {
    if (!credential) return 'no-credential'
    return createHash('sha256').update(credential).digest('hex').slice(0, 16)
  }
  /**
   * Record a denial. Returns true when the caller should get the fast-path
   * response (over the limit) — the edge skips the expensive deny work and
   * logs sparsely.
   */
  deny(key: string, now = Date.now()): { throttled: boolean; log: boolean } {
    const window = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    window.push(now)
    this.hits.set(key, window)
    if (window.length <= this.perWindow) return { throttled: false, log: true }
    const count = (this.throttled.get(key) ?? 0) + 1
    this.throttled.set(key, count)
    return { throttled: true, log: count % this.logEvery === 1 }
  }
}
