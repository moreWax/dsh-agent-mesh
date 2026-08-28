/**
 * Lifecycle-safe client for SAM's local service registry. Registers any
 * MCP-over-HTTP endpoint (task service, chat inbox, ...) with the node so
 * peers discover it; unregister on shutdown. Generic mesh infra — lives here
 * so every plugin (and the CLI) shares one implementation.
 */
export interface SamRegistrationTransport {
  request<T>(path: string, options: { method: string; body?: unknown; signal?: AbortSignal }): Promise<T>
  requestRaw?(path: string, options: { method: string; body?: unknown; signal?: AbortSignal }): Promise<{ status: number; body: AsyncIterable<Uint8Array> }>
}
export interface SamServiceRegistration { id?: string; name: string; endpoint: string; raw: unknown }
export interface SamRegistrationOptions { name?: string; description?: string; ttlSeconds?: number }

export class SamServiceRegistrationClient {
  constructor(readonly transport: SamRegistrationTransport) {}
  async register(address: { mcpUrl: string } | string, options: SamRegistrationOptions = {}, signal?: AbortSignal): Promise<SamServiceRegistration> {
    const endpoint = typeof address === 'string' ? address : address.mcpUrl
    const name = options.name ?? 'dsh-service'
    const request = { method: 'POST', body: { service: { name, type: 'SERVICE_TYPE_MCP', ...(options.description ? { description: options.description } : {}) }, target_url: endpoint }, ...(signal ? { signal } : {}) }
    const raw = this.transport.requestRaw
      ? await this.transport.requestRaw('/sam/service/register', request).then((response: { status: number }) => { if (response.status < 200 || response.status >= 300) throw new Error(`SAM registration failed (${response.status})`); return {} as Record<string, unknown> })
      : await this.transport.request<Record<string, unknown>>('/sam/service/register', request)
    const service = raw?.service ?? raw
    return { ...(typeof (service as { id?: unknown })?.id === 'string' ? { id: (service as { id: string }).id } : {}), name, endpoint, raw }
  }
  async unregister(registration: Pick<SamServiceRegistration, 'id' | 'name'>, signal?: AbortSignal): Promise<void> {
    const request = { method: 'POST', body: { name: registration.name, type: 1 }, ...(signal ? { signal } : {}) }
    if (this.transport.requestRaw) await this.transport.requestRaw('/sam/service/unregister', request).then((response: { status: number }) => { if (response.status < 200 || response.status >= 300) throw new Error(`SAM unregister failed (${response.status})`) })
    else await this.transport.request('/sam/service/unregister', request)
  }
}
