import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { TaskProtocolError, type JsonObject } from './types.js'
import { TaskService } from './service.js'
import { CapabilityAuthorizer, extractCredentials, runAuthorizers, type Authorizer } from './authz.js'

export interface TaskHttpServerOptions { host?: string; port?: number; path?: string; healthPath?: string; serviceName?: string; shutdownTimeoutMs?: number
  /**
   * Fleet capability sugar: equivalent to authorizers: [new
   * CapabilityAuthorizer(value)]. Non-open tools must carry the secret in
   * arguments._capability — the authorization boundary for a service
   * announced on a PUBLIC hub (sam-node's pass-through has no caller
   * authz, so the service brings its own). In-process callers bypass HTTP
   * entirely. initialize/tools/list stay open: the chain protects
   * execution and data, not the existence of the tool roster.
   */
  capability?: string
  /** Attribution sink: every tools/call verdict lands here (tool, member when identified, allowed). Never arguments. */
  onAudit?: (event: { tool: string; allowed: boolean; member?: string }) => void
  /** Authorization chain; runs in order against each tool's declared auth. */
  authorizers?: Authorizer[] }
export interface TaskHttpAddress { host: string; port: number; mcpUrl: string; healthUrl: string }
function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string,string> = {}): void { const data = body === undefined ? '' : JSON.stringify(body); res.writeHead(status, { ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers }); res.end(data) }
async function body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[]=[]; let n=0; for await (const raw of req) { const c=Buffer.from(raw); n+=c.length; if(n>1024*1024) throw new Error('request body too large'); chunks.push(c) } return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
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
      else if(msg.method==='tools/list') result={tools:this.tasks.tools.list()}
      else if(msg.method==='tools/call') {
        const name=msg.params?.name; if(typeof name!=='string') throw new TaskProtocolError({code:'TASK_PROTOCOL_INVALID_REQUEST',message:'tool name is required'})
        const tool = this.tasks.tools.get(name)
        if (!tool) throw new TaskProtocolError({code:'TASK_TOOL_NOT_FOUND',message:`Unknown task tool: ${name}`})
        // Credentials leave the arguments at the edge; handlers never see them.
        const { args, ctx: authCtx } = extractCredentials({ ...((msg.params?.arguments ?? {}) as JsonObject) })
        const authorizers = this.options.authorizers ?? (this.options.capability !== undefined ? [new CapabilityAuthorizer(this.options.capability)] : [])
        const verdict = await runAuthorizers(authorizers, tool, args, authCtx)
        this.options.onAudit?.({ tool: name, allowed: verdict.allow, ...(verdict.allow && verdict.member ? { member: verdict.member } : {}) })
        if (!verdict.allow) {
          return send(res,200,{jsonrpc:'2.0',id:msg.id??null,error:{code:-32602,message:verdict.message}})
        }
        const value=await tool.handler(args,{signal:abort.signal,...(verdict.allow&&verdict.member?{member:verdict.member}:{})}); result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}
      }
      else return send(res,200,{jsonrpc:'2.0',id:msg.id??null,error:{code:-32601,message:'Method not found'}})
      return send(res,200,rpc(msg.id,result))
    } catch(e) { const err=e instanceof TaskProtocolError?e:{code:'TASK_INTERNAL_ERROR',message:e instanceof Error?e.message:String(e),retryable:false}; return send(res,200,rpc(msg.id,{content:[{type:'text',text:err.message}],structuredContent:{error:{code:err.code,message:err.message,retryable:err.retryable}},isError:true})) }
  }
}
