/**
 * Shared host/plugin helpers — the seams every dsh plugin needs, in one
 * place (they previously existed as per-plugin copies and had to be fixed
 * twice when one of them bit).
 */

/** Unwrap an MCP tool envelope: callRemoteTool returns { content,
 *  structuredContent } — reading fields off the envelope is the classic
 *  silent failure (state/pending/members read as undefined while the call
 *  succeeds). Payload-first, envelope as fallback. */
export function toolPayload<T extends Record<string, unknown>>(result: unknown): T {
  if (typeof result === 'object' && result !== null) {
    const structured = (result as { structuredContent?: unknown }).structuredContent
    if (structured && typeof structured === 'object') return structured as T
    return result as T
  }
  return {} as T
}

/**
 * mtime-cached JSON file view: re-reads only when the file changes (the
 * fleet-members registry pattern). Missing/unreadable file = `empty` (fail
 * closed), never a crash.
 */
export class JsonFileView<T> {
  private cache: { mtimeMs: number; value: T } | undefined
  constructor(
    private readonly path: string,
    private readonly parse: (raw: string) => T,
    private readonly empty: T,
    private readonly statFn: (path: string) => Promise<{ mtimeMs: number }>,
  ) {}
  async get(): Promise<T> {
    let mtimeMs = 0
    try { mtimeMs = (await this.statFn(this.path)).mtimeMs } catch { /* missing = empty */ }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.value
    let value = this.empty
    try {
      const { readFile } = await import('node:fs/promises')
      value = this.parse(await readFile(this.path, 'utf8'))
    } catch { value = this.empty }
    this.cache = { mtimeMs, value }
    return value
  }
}

/** The version of the package a module file belongs to, read from its
 *  package.json (single source of truth — never a hardcoded string). */
export async function packageVersionOf(packageJsonUrl: string | URL): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const parsed = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as { version?: unknown }
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
}
