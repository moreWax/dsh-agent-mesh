import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { TaskProtocolError, type JsonObject } from './types.js'
import { TaskService } from './service.js'

export const TASK_TOOL_SCHEMAS = Object.freeze({
  task_submit: { type: 'object', required: ['idempotencyKey', 'input'], properties: { idempotencyKey: { type: 'string', minLength: 1 }, input: {}, kind: { type: 'string' }, deadline: { type: 'string', format: 'date-time' }, parentTaskId: { type: 'string' }, sessionId: { type: 'string' }, agentId: { type: 'string' }, metadata: { type: 'object' } }, additionalProperties: false },
  task_get: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', minLength: 1 } }, additionalProperties: false },
  task_watch: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', minLength: 1 }, cursor: { type: 'string' }, waitMs: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  task_cancel: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', minLength: 1 }, reason: { type: 'string' } }, additionalProperties: false },
  task_collect: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', minLength: 1 }, deadline: { type: 'string', format: 'date-time' }, waitMs: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  fleet_pair_request: { type: 'object', required: ['requestId', 'publicKey'], properties: { requestId: { type: 'string', minLength: 16 }, publicKey: { type: 'string', minLength: 1 }, label: { type: 'string' } }, additionalProperties: false },
  fleet_pair_poll: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string', minLength: 1 } }, additionalProperties: false },
  fleet_pair_list: { type: 'object', properties: {}, additionalProperties: false },
  fleet_pair_approve: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string', minLength: 1 }, approvedBy: { type: 'string' } }, additionalProperties: false },
  fleet_pair_reject: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string', minLength: 1 } }, additionalProperties: false },
} as const)
const descriptions: Record<string, string> = { task_submit: 'Submit an idempotent durable task', task_get: 'Get a task snapshot', task_watch: 'Long-poll task events from a cursor', task_cancel: 'Cancel queued or running task execution', task_collect: 'Wait for a terminal task snapshot',
  fleet_pair_request: 'Request to join this fleet (ungated; sealed delivery after operator approval)', fleet_pair_poll: 'Poll a pair request (ungated; single-use once approved)',
  fleet_pair_list: 'List pending fleet pair requests (capability-gated)', fleet_pair_approve: 'Approve a pair request — seals the fleet invite to the requester (capability-gated)', fleet_pair_reject: 'Reject a pending pair request (capability-gated)' }
export interface TaskHttpServerOptions { host?: string; port?: number; path?: string; healthPath?: string; serviceName?: string; shutdownTimeoutMs?: number
  /**
   * Fleet capability: when set, tools/call requests must carry it in
   * arguments._capability or the call is rejected before dispatch. This is
   * the authorization boundary for a service announced on a PUBLIC hub —
   * sam-node's pass-through has no caller authz, so the service brings its
   * own. In-process callers (ctx.agentMeshTaskService) bypass HTTP entirely
   * and are unaffected. initialize/tools/list stay open: the gate protects
   * execution and data, not the existence of the tool roster.
   */
  capability?: string }
export interface TaskHttpAddress { host: string; port: number; mcpUrl: string; healthUrl: string }
function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string,string> = {}): void { const data = body === undefined ? '' : JSON.stringify(body); res.writeHead(status, { ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers }); res.end(data) }
async function body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[]=[]; let n=0; for await (const raw of req) { const c=Buffer.from(raw); n+=c.length; if(n>1024*1024) throw new Error('request body too large'); chunks.push(c) } return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
/** Pairing bootstrap tools are ungated BY DESIGN — see tasks/pairing.ts. */
const UNGATED_TOOLS = new Set(['fleet_pair_request', 'fleet_pair_poll'])

function capabilityMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented); const b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}
function rpc(id: unknown, result: unknown) { return { jsonrpc: '2.0', id: id ?? null, result } }
export class TaskHttpServer {
  private server: Server | undefined; private stopping: Promise<void> | undefined; private readonly path: string; private readonly healthPath: string
  constructor(readonly tasks: TaskService, readonly options: TaskHttpServerOptions = {}) { this.path=options.path ?? '/mcp'; this.healthPath=options.healthPath ?? '/healthz' }
  async start(): Promise<TaskHttpAddress> { if(this.server) return this.address(); const server=createServer((req,res)=>void this.handle(req,res)); this.server=server; await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.options.port ?? 0,this.options.host ?? '127.0.0.1',()=>{server.off('error',reject);resolve()})}); return this.address() }
  address(): TaskHttpAddress { if(!this.server) throw new Error('server is not started'); const a=this.server.address() as AddressInfo; const host=a.address.includes(':') ? `[${a.address}]` : a.address; return { host:a.address,port:a.port,mcpUrl:`http://${host}:${a.port}${this.path}`,healthUrl:`http://${host}:${a.port}${this.healthPath}` } }
  async stop(): Promise<void> { if(this.stopping) return this.stopping; this.stopping=(async()=>{const s=this.server;if(!s)return; s.close(); await this.tasks.shutdown({ waitMs:this.options.shutdownTimeoutMs ?? 5000 }); s.closeAllConnections(); await once(s,'close').catch(()=>{}); this.server=undefined})().finally(()=>{this.stopping=undefined}); return this.stopping }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void> { if(req.url===this.healthPath && req.method==='GET') return send(res,200,{status:'ok',service:this.options.serviceName ?? 'task-service'}); if(req.url!==this.path) return send(res,404,{error:'not found'}); if(req.method==='GET') return send(res,405,{error:'SSE GET is not required; use Streamable HTTP POST'},{allow:'POST, DELETE'}); if(req.method==='DELETE') return send(res,204); if(req.method!=='POST') return send(res,405,{error:'method not allowed'},{allow:'POST, DELETE'});
    const abort=new AbortController(); req.on('aborted',()=>abort.abort()); res.on('close',()=>{if(!res.writableEnded)abort.abort()});
    let msg:any; try { msg=await body(req) } catch(e) { return send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:e instanceof Error?e.message:'parse error'}}) }
    if(msg?.jsonrpc!=='2.0'||typeof msg.method!=='string') return send(res,400,{jsonrpc:'2.0',id:msg?.id??null,error:{code:-32600,message:'Invalid Request'}})
    if(msg.method==='notifications/initialized') return send(res,202)
    try { let result:unknown
      if(msg.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:this.options.serviceName ?? 'dsh-task-service',version:'0.1.0'}}
      else if(msg.method==='ping') result={}
      else if(msg.method==='tools/list') result={tools:Object.entries(TASK_TOOL_SCHEMAS).map(([name,inputSchema])=>({name,description:descriptions[name],inputSchema}))}
      else if(msg.method==='tools/call') {
        const name=msg.params?.name; if(typeof name!=='string') throw new TaskProtocolError({code:'TASK_PROTOCOL_INVALID_REQUEST',message:'tool name is required'})
        const args = { ...((msg.params?.arguments ?? {}) as JsonObject) }
        if (this.options.capability !== undefined && !UNGATED_TOOLS.has(name)) {
          const presented = typeof args._capability === 'string' ? args._capability : ''
          delete args._capability
          // Uniform rejection: missing and wrong capability are
          // indistinguishable — no oracle about which part failed.
          if (!capabilityMatches(presented, this.options.capability)) {
            return send(res,200,{jsonrpc:'2.0',id:msg.id??null,error:{code:-32602,message:'capability required'}})
          }
        }
        const value=await this.tasks.callTool(name,args,{signal:abort.signal}); result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}
      }
      else return send(res,200,{jsonrpc:'2.0',id:msg.id??null,error:{code:-32601,message:'Method not found'}})
      return send(res,200,rpc(msg.id,result))
    } catch(e) { const err=e instanceof TaskProtocolError?e:{code:'TASK_INTERNAL_ERROR',message:e instanceof Error?e.message:String(e),retryable:false}; return send(res,200,rpc(msg.id,{content:[{type:'text',text:err.message}],structuredContent:{error:{code:err.code,message:err.message,retryable:err.retryable}},isError:true})) }
  }
}
