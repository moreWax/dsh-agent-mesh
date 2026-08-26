import type { TaskHttpAddress } from './http.js'
export interface SamRegistrationTransport { request<T>(path: string, options: { method: string; body?: unknown; signal?: AbortSignal }): Promise<T>; requestRaw?(path:string,options:{method:string;body?:unknown;signal?:AbortSignal}):Promise<{status:number;body:AsyncIterable<Uint8Array>}> }
export interface TaskServiceRegistration { id?: string; name: string; endpoint: string; raw: unknown }
export interface TaskRegistrationOptions { name?: string; description?: string; ttlSeconds?: number }
/** Lifecycle-safe client for SAM's local service registry. */
export class SamTaskRegistrationClient {
  constructor(readonly transport: SamRegistrationTransport) {}
  async register(address: TaskHttpAddress | string, options: TaskRegistrationOptions = {}, signal?: AbortSignal): Promise<TaskServiceRegistration> {
    const endpoint=typeof address==='string'?address:address.mcpUrl; const name=options.name ?? 'dsh-task-service'
    const request={method:'POST',body:{service:{name,type:'SERVICE_TYPE_MCP',...(options.description?{description:options.description}:{})},target_url:endpoint},...(signal?{signal}:{})}
    const raw:any=this.transport.requestRaw ? await this.transport.requestRaw('/sam/service/register',request).then(response=>{if(response.status<200||response.status>=300)throw new Error(`SAM registration failed (${response.status})`);return {}}) : await this.transport.request('/sam/service/register',request)
    const service=raw?.service ?? raw
    return { ...(typeof service?.id==='string'?{id:service.id}:{}),name,endpoint,raw }
  }
  async unregister(registration: Pick<TaskServiceRegistration,'id'|'name'>, signal?: AbortSignal): Promise<void> {
    const request={method:'POST',body:{name:registration.name,type:1},...(signal?{signal}:{})}
    if(this.transport.requestRaw) await this.transport.requestRaw('/sam/service/unregister',request).then(response=>{if(response.status<200||response.status>=300)throw new Error(`SAM unregister failed (${response.status})`)})
    else await this.transport.request('/sam/service/unregister',request)
  }
}
