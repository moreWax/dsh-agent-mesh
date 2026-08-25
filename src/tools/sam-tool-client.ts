/** Policy-aware remote MCP capability discovery and invocation. */
import { mcpToolUri, toolIdentity } from './identity.js'
import type { CallToolOptions,CallToolResult,DescribeToolOptions,DiscoverToolsOptions,JsonObject,RequiredLabelsAnyOf,ToolDescription,ToolSearchResult,ToolSummary } from './types.js'
export interface SamToolTransport { callTool(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<any> }
function labels(labels:RequiredLabelsAnyOf|undefined):string|undefined { if(!labels)return undefined;const values=Array.isArray(labels)?labels.map(x=>typeof x==='string'?x:`${x.key}=${x.value}`):Object.entries(labels).map(([k,v])=>`${k}=${v}`);if(values.length===0)throw new TypeError('requiredLabelsAnyOf must not be empty');for(const v of values)if(!/^[^=,\s]+=[^,\s]+$/.test(v))throw new TypeError(`Invalid required label ${v}`);return values.join(',') }
interface RawTool {peer_id:string;tool_name:string;description?:string;labels?:Record<string,string>;input_schema?:Record<string,unknown>;output_schema?:Record<string,unknown>}
export class SamToolClient {
 private cache=new Map<string,ToolDescription>()
 constructor(private readonly core:SamToolTransport,private readonly schemaTtlMs=30_000){}
 async find(options:DiscoverToolsOptions={},signal?:AbortSignal):Promise<ToolSearchResult>{
  const raw=await this.core.callTool('find_remote_tools',{...(options.intent?{intent:options.intent}:{}),...(options.peerId?{peer_id:options.peerId}:{}),...(options.serviceName?{service_name:options.serviceName}:{}),...(options.toolName?{tool_name:options.toolName}:{})},signal)
  const tools:ToolSummary[]=(raw as RawTool[]).map((item:RawTool)=>({...toolIdentity(item.peer_id,item.tool_name),...(item.description?{description:item.description}:{}),...(item.labels?{labels:item.labels}:{})}))
  return {tools,complete:true,partial:false,failures:[]}
 }
 async describe(peerId:string,uri:string,options:DescribeToolOptions={},signal?:AbortSignal):Promise<ToolDescription>{
  const key=`${peerId}\0${uri}`,cached=this.cache.get(key),max=options.maxAgeMs??this.schemaTtlMs
  if(!options.force&&cached&&Date.now()-cached.schemaFetchedAt<=max)return {...cached,fromCache:true}
  const raw=await this.core.callTool('describe_remote_tool',{peer_id:peerId,tool_name:uri},signal)
  const identity=toolIdentity(peerId,uri);const value:ToolDescription={...identity,...(raw.description !== undefined ? {description:raw.description} : {}),inputSchema:raw.input_schema??{},...(raw.output_schema?{outputSchema:raw.output_schema}:{}),schemaFetchedAt:Date.now(),fromCache:false};this.cache.set(key,value);return value
 }
 async call(peerId:string,uri:string,arguments_:JsonObject,options:CallToolOptions={},signal?:AbortSignal):Promise<CallToolResult>{
  if(options.revalidateSchema!==false)await this.describe(peerId,uri,{maxAgeMs:options.schemaMaxAgeMs??this.schemaTtlMs},signal)
  return this.core.callTool('call_remote_tool',{peer_id:peerId,tool_name:uri,arguments:arguments_,...(labels(options.requiredLabelsAnyOf)?{required_labels:labels(options.requiredLabelsAnyOf)}:{})},signal)
 }
 canonical(service:string,tool:string):string{return mcpToolUri(service,tool)}
}
export default SamToolClient
