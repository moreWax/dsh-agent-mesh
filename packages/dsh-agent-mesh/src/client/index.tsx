import { useCallback, useEffect, useState } from "react"
import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-api-gateway/client"
import type {} from "@deepseek-ai/dsh-client-runtime/client"
import type {} from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-settings/client"
import remoteContribution from "../remote.js"
import type { ActionResult, ApprovedAction, MeshDashboardSnapshot } from "../web/host.js"
import type { ServiceRegistrationRequest, SkillInstallRequest } from "../operator/index.js"
import type { EnrollmentInfo, NodeStatus } from "@morewax/sam-mesh/node"
export interface MeshWebApi { snapshot():Promise<MeshDashboardSnapshot>; check():Promise<MeshDashboardSnapshot>; startNode(a:ApprovedAction):Promise<ActionResult>; installSkill(r:SkillInstallRequest,a:ApprovedAction):Promise<ActionResult>; registerService(r:ServiceRegistrationRequest,a:ApprovedAction):Promise<ActionResult>; deviceFlowInstructions():Promise<string[]>; nodeStatus():Promise<NodeStatus>; stopNode(a:ApprovedAction):Promise<ActionResult>; beginEnrollment(a:ApprovedAction,o?:{controlPlane?:string}):Promise<EnrollmentInfo|ActionResult>; enrollmentStatus(id:string):Promise<EnrollmentInfo|null>; cancelEnrollment(id:string):Promise<ActionResult> }
function unwrap<T>(r:{ok:true;value:T}|{ok:false;error:{message:string}}):T { if(!r.ok) throw new Error(r.error.message); return r.value }
export function createMeshWebApi(ctx:Context):MeshWebApi { const r=ctx.remote.agentMeshWeb; return {snapshot:async()=>unwrap(await r.snapshot()),check:async()=>unwrap(await r.check()),startNode:async a=>unwrap(await r.startNode(a)),installSkill:async(q,a)=>unwrap(await r.installSkill(q,a)),registerService:async(q,a)=>unwrap(await r.registerService(q,a)),deviceFlowInstructions:async()=>unwrap(await r.deviceFlowInstructions()),nodeStatus:async()=>unwrap(await r.nodeStatus()),stopNode:async a=>unwrap(await r.stopNode(a)),beginEnrollment:async(a,o)=>unwrap(await r.beginEnrollment(a,o)),enrollmentStatus:async id=>unwrap(await r.enrollmentStatus(id)),cancelEnrollment:async id=>unwrap(await r.cancelEnrollment(id))} }
const box:React.CSSProperties={border:"1px solid var(--border,#444)",borderRadius:10,padding:16,display:"grid",gap:12}; const button:React.CSSProperties={padding:"7px 12px",borderRadius:6,cursor:"pointer"};
function Json({value}:{value:unknown}) { return <pre style={{whiteSpace:"pre-wrap",maxHeight:220,overflow:"auto",fontSize:12}}>{JSON.stringify(value,null,2)}</pre> }
export function MeshSettingsCard({api}:{api:MeshWebApi}) { const [s,setS]=useState<MeshDashboardSnapshot>(); const [error,setError]=useState(""); const [notice,setNotice]=useState(""); const load=useCallback(async()=>{setError("");try{setS(await api.snapshot())}catch(e){setError(e instanceof Error?e.message:String(e))}},[api]); useEffect(()=>{void load()},[load]);
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"}); const act=async(f:()=>Promise<ActionResult>)=>{const result=await f();setNotice(result.ok?result.message:result.error);await load()};
 return <section style={box} data-testid="agent-mesh-settings"><header><h2 style={{margin:0}}>Agent Mesh</h2><small>Read-only status; mutations run only after the button you select.</small></header>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 <div><button style={button} onClick={()=>void load()}>Check connection</button>{" "}<button style={button} onClick={()=>void act(()=>api.startNode(approve()))}>Start node (approved)</button>{" "}<button style={button} onClick={()=>void api.deviceFlowInstructions().then(x=>setNotice(x.join("\n")))}>Enrollment instructions</button></div>
 <NodeSection api={api} onChanged={load}/>
 {s&&<><dl><dt>Transport</dt><dd>{s.transport.kind}: {s.transport.endpoint}</dd><dt>Peer ID / router / peers / DHT / token / connectivity</dt><dd><Json value={{mesh:s.mesh,network:s.network,token:s.token}}/></dd></dl>
 {(["services","tools","models","failures","tasks","logs"] as const).map(k=><details key={k}><summary>{k} ({s[k].length})</summary><Json value={s[k]}/></details>)}<small>Captured {s.capturedAt}</small></>}
 <details><summary>Approved actions</summary><ActionForms api={api} run={act}/><p>No reset, purge, delete, cancellation, or other destructive action is exposed.</p></details></section> }

function isActionResult(v:EnrollmentInfo|ActionResult):v is ActionResult { return "ok" in v }

/** Mesh node kit: bring THIS machine onto the mesh — install check, daemon
 * lifecycle, and browser-based device-flow enrollment, all from the card. */
function NodeSection({api,onChanged}:{api:MeshWebApi;onChanged:()=>Promise<void>}) {
 const [status,setStatus]=useState<NodeStatus>(); const [session,setSession]=useState<EnrollmentInfo|null>(null)
 const [note,setNote]=useState("")
 const refresh=useCallback(async()=>{ setStatus(await api.nodeStatus()) },[api])
 useEffect(()=>{ void refresh() },[refresh])
 // Poll an in-flight enrollment until it resolves.
 useEffect(()=>{ if(!session||(session.state!=="starting"&&session.state!=="awaiting_user")) return
  const t=setInterval(async()=>{ const info=await api.enrollmentStatus(session.sessionId); if(info){ setSession(info); if(info.state==="complete"){ setNote("Enrolled — starting the node…"); await refresh(); await onChanged() } } },1500)
  return ()=>clearInterval(t) },[session,api,refresh,onChanged])
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const act=async(f:()=>Promise<ActionResult>)=>{ const r=await f(); setNote(r.ok?r.message:r.error); await refresh() }
 const begin=async()=>{ const r=await api.beginEnrollment(approve()); if(isActionResult(r)) setNote(r.ok?r.message:r.error); else setSession(r) }
 if(!status) return null
 return <details open={!status.enrolled}><summary>Mesh node ({status.running?"running":status.enrolled?"enrolled, stopped":"not enrolled"})</summary>
  <div style={{display:"grid",gap:8,marginTop:8}}>
   <dl style={{margin:0}}><dt>Binary</dt><dd>{status.installed?status.binaryPath:"sam-node not found on PATH"}</dd><dt>Data dir</dt><dd>{status.dataDir}</dd>{status.pid!==null&&<><dt>PID</dt><dd>{status.pid}</dd></>}</dl>
   <div>
    {!status.running&&status.enrolled&&<button style={button} onClick={()=>void act(()=>api.startNode(approve()))}>Start node (approved)</button>}{" "}
    {status.running&&<button style={button} onClick={()=>void act(()=>api.stopNode(approve()))}>Stop node (approved)</button>}{" "}
    {!status.enrolled&&status.installed&&!session&&<button style={button} onClick={()=>void begin()}>Enroll this machine (approved)</button>}
   </div>
   {session&&(session.state==="starting"||session.state==="awaiting_user")&&<div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:12}}>
    {session.state==="starting"?<p>Contacting the control plane…</p>:<>
     <p style={{margin:"0 0 6px"}}><b>Authorize this machine:</b></p>
     <p style={{margin:"0 0 6px"}}><a href={session.verificationUrl!} target="_blank" rel="noreferrer">{session.verificationUrl}</a></p>
     <p style={{margin:"0 0 10px",fontSize:18,letterSpacing:2}}><b>{session.userCode}</b></p>
     <button style={button} onClick={()=>void act(()=>api.cancelEnrollment(session.sessionId)).then(()=>setSession(null))}>Cancel enrollment</button>
    </>}
   </div>}
   {session&&(session.state==="failed"||session.state==="cancelled")&&<p role="alert">Enrollment {session.state}{session.error?`: ${session.error}`:""}</p>}
   {note&&<p role="status">{note}</p>}
  </div></details> }

function ActionForms({api,run}:{api:MeshWebApi;run:(f:()=>Promise<ActionResult>)=>Promise<void>}) { const [source,setSource]=useState("");const [name,setName]=useState("");const [protocol,setProtocol]=useState("http");const [endpoint,setEndpoint]=useState("");const a={approved:true,approvedBy:"DeepSeek Harness web user"};return <div style={{display:"grid",gap:8}}><label>Skill source <input value={source} onChange={e=>setSource(e.target.value)}/></label><button style={button} disabled={!source.trim()} onClick={()=>void run(()=>api.installSkill({source:source.trim()},a))}>Install skill (approved)</button><label>Service name <input value={name} onChange={e=>setName(e.target.value)}/></label><label>Protocol <input value={protocol} onChange={e=>setProtocol(e.target.value)}/></label><label>Endpoint <input value={endpoint} onChange={e=>setEndpoint(e.target.value)}/></label><button style={button} disabled={!name.trim()||!endpoint.trim()} onClick={()=>void run(()=>api.registerService({name:name.trim(),protocol:protocol.trim(),endpoint:endpoint.trim()},a))}>Register service (approved)</button></div> }
export const name="agent-mesh-client"; export const inject=["slots","remote"] as const
export async function apply(ctx:Context):Promise<()=>Promise<void>> { const dispose=await ctx.remote.$mount(remoteContribution);const api=createMeshWebApi(ctx);ctx.slots.inject("settings.section",()=>ctx.slots.register({name:"settings.section",id:"agent-mesh",order:70,label:"Agent Mesh"},()=> <MeshSettingsCard api={api}/>));return dispose }
