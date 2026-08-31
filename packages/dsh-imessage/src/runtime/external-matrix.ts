import type { ExternalMatrixValidation, IMessageRuntime, RuntimeCheck, RuntimeDetection, RuntimeLogOptions, RuntimeStatus } from './interface.js'
import { RuntimeError } from './errors.js'

export interface ExternalMatrixOptions extends ExternalMatrixValidation { fetch?: typeof fetch; timeoutMs?: number }

export class ExternalMatrixRuntime implements IMessageRuntime {
  readonly kind = 'external-matrix' as const
  private readonly request: typeof fetch
  constructor(private readonly options: ExternalMatrixOptions) { this.request = options.fetch ?? fetch }
  private base(): string { return this.options.homeserverUrl.replace(/\/$/, '') }
  private async api(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 8_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try { return await this.request(`${this.base()}${path}`, { ...init, signal: combined, headers: { authorization: `Bearer ${this.options.accessToken}`, 'content-type': 'application/json', ...init.headers } }) }
    catch (cause) { throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'External Matrix is unreachable', 'Check the homeserver URL and network connectivity', true, { cause }) }
  }
  private result(name: string, response: Response, expected: readonly number[], fix: string): RuntimeCheck { const ok = expected.includes(response.status); return { name, ok, required: true, detail: ok ? `HTTP ${response.status}` : `HTTP ${response.status}`, ...(ok ? {} : { fix }) } }
  async detect(signal?: AbortSignal): Promise<RuntimeDetection> {
    const checks: RuntimeCheck[] = []
    let response: Response
    try { response = await this.api('/_matrix/client/versions', { method: 'GET', headers: {} }, signal); checks.push(this.result('homeserver', response, [200], 'Verify the Matrix homeserver URL')) }
    catch { checks.push({ name: 'homeserver', ok: false, required: true, detail: 'unreachable', fix: 'Verify the Matrix homeserver URL and network' }); return { kind: this.kind, available: false, checks } }
    response = await this.api('/_matrix/client/v3/account/whoami', { method: 'GET' }, signal); checks.push(this.result('credential', response, [200], 'Replace the Matrix credential reference'))
    if (!checks.at(-1)?.ok) return { kind: this.kind, available: false, checks }
    response = await this.api(`/_matrix/client/v3/rooms/${encodeURIComponent(this.options.roomId)}/state`, { method: 'GET' }, signal); checks.push(this.result('room', response, [200], 'Invite the bridge account to the configured room and verify the room ID'))
    response = await this.api('/_matrix/media/v3/config', { method: 'GET' }, signal); checks.push(this.result('media', response, [200], 'Enable or permit the Matrix media API'))
    response = await this.api('/_matrix/client/v3/search', { method: 'POST', body: JSON.stringify({ search_categories: { room_events: { search_term: '__dsh_probe_no_match__', filter: { rooms: [this.options.roomId] }, limit: 1 } } }) }, signal); checks.push(this.result('search', response, [200], 'Enable room event search or choose a compatible homeserver'))
    if (this.options.bridgeHealthUrl) {
      try { const health = await this.request(this.options.bridgeHealthUrl, { method: 'GET', ...(signal ? { signal } : {}) }); checks.push(this.result('corten-bridge', health, [200, 204], 'Start or repair corten-matrix')) }
      catch { checks.push({ name: 'corten-bridge', ok: false, required: true, detail: 'unreachable', fix: 'Start or repair corten-matrix' }) }
    }
    return { kind: this.kind, available: checks.every(check => check.ok || !check.required), checks }
  }
  async prepare(signal?: AbortSignal): Promise<void> { const detected = await this.detect(signal); if (!detected.available) throw new RuntimeError('IMESSAGE_RUNTIME_NOT_CONFIGURED', 'External Matrix validation failed', 'Resolve the failed checks in iMessage setup', false) }
  async start(signal?: AbortSignal): Promise<void> { await this.prepare(signal) }
  async status(signal?: AbortSignal): Promise<RuntimeStatus> { const detected = await this.detect(signal); return { kind: this.kind, health: detected.available ? 'ready' : 'unavailable', detail: detected.available ? 'External Matrix is ready' : 'External Matrix needs attention', checks: detected.checks, lastCheckedAt: new Date().toISOString() } }
  async stop(_signal?: AbortSignal): Promise<void> { /* External services are not owned. */ }
  async remove(_signal?: AbortSignal): Promise<void> { /* References are reset by setup state, never delete external data. */ }
  async *logs(_options: RuntimeLogOptions): AsyncIterable<string> { throw new RuntimeError('IMESSAGE_RUNTIME_UNSUPPORTED', 'External Matrix logs are managed by its operator', 'Inspect logs on the external Matrix/corten deployment', false) }
}
