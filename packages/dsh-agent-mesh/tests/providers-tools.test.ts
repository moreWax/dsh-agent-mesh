import { describe, expect, it } from 'vitest'
import { projectedToolName, SamToolPolicyError, SamToolsProvider } from '../src/providers/tools.js'

function harness() {
  const registered = new Map<string, any>(); const calls:any[]=[]; const described:any[]=[]
  const remote = [{ peerId:'peer/alpha', uri:'mcp://svc/echo', serviceName:'svc', toolName:'echo' }]
  const tools:any = {
    async find(_filter:any, signal:AbortSignal) { expect(signal).toBeInstanceOf(AbortSignal); return { tools:remote, complete:true, partial:false, failures:[] } },
    async describe(peerId:string, uri:string, options:any, signal:AbortSignal) { described.push([peerId,uri,options.force,signal]); return {...remote[0], inputSchema:{type:'object'}, schemaFetchedAt:Date.now(), fromCache:false, description:'echo'} },
    async call(peerId:string,uri:string,args:any,options:any,signal:AbortSignal) { calls.push({peerId,uri,args,options,signal}); return {content:[{type:'text',text:'ok'}],structuredContent:{answer:1}} },
  }
  const ctx:any={agentMesh:{tools},tools:{register(def:any){if(registered.has(def.name))throw Error('conflict');registered.set(def.name,def);return()=>registered.delete(def.name)}}}
  return {ctx,tools,registered,calls,described}
}
describe('SAM ctx.tools provider',()=>{
 it('uses stable peer+URI hashed names, mandatory describe, labels, cancellation and result projection',async()=>{const h=harness();const p=new SamToolsProvider(h.ctx,{requiredLabelsAnyOf:['region=eu']});await p.refresh();expect(h.described).toHaveLength(1);const [name,def]=[...h.registered][0]!;expect(name).toBe(projectedToolName('peer/alpha','mcp://svc/echo'));expect(name).toMatch(/^sam__/);const abort=new AbortController();const value=await def.execute({x:1},{signal:abort.signal});expect(h.calls[0].signal).toBe(abort.signal);expect(h.calls[0].options.requiredLabelsAnyOf).toEqual(['region=eu']);expect(value.structuredContent).toEqual({answer:1});expect(def.output.render({},value)).toEqual([{type:'text',text:'ok'}]);p.dispose();expect(h.registered.size).toBe(0)})
 it('retains the previous complete generation when a refresh fails before swap',async()=>{const h=harness();const p=new SamToolsProvider(h.ctx);await p.refresh();h.tools.describe=async()=>{throw Error('offline')};await expect(p.refresh()).rejects.toThrow('offline');expect(h.registered.size).toBe(1)})
 it('projects policy rejection as a typed actionable error',async()=>{const h=harness();const p=new SamToolsProvider(h.ctx);await p.refresh();h.tools.call=async()=>{throw Error('Biscuit policy denied required_labels')};const def=[...h.registered.values()][0];await expect(def.execute({}, {signal:new AbortController().signal})).rejects.toBeInstanceOf(SamToolPolicyError)})
 it('never collapses distinct peer/URI identities',()=>{expect(projectedToolName('p1','mcp://s/t')).not.toBe(projectedToolName('p2','mcp://s/t'));expect(projectedToolName('p1','mcp://s/t')).not.toBe(projectedToolName('p1','mcp://x/t'))})
})
