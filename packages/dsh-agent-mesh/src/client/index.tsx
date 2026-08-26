import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-api-gateway/client"
import type {} from "@deepseek-ai/dsh-client-runtime/client"
import type {} from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-settings/client"
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client"
import type { SettingsScope } from "@deepseek-ai/dsh-client-runtime/client"
import remoteContribution from "../remote.js"
import type { ActionResult, ApprovedAction, MeshDashboardSnapshot } from "../web/host.js"
import type { ServiceRegistrationRequest, SkillInstallRequest } from "../operator/index.js"
import type { EnrollmentInfo } from "@morewax/sam-mesh/node"
import type { DoctorCheck } from "@morewax/sam-mesh/plan"
import type { NodeStatusView } from "../web/host.js"
export interface MeshWebApi { snapshot():Promise<MeshDashboardSnapshot>; check():Promise<MeshDashboardSnapshot>; startNode(a:ApprovedAction):Promise<ActionResult>; installSkill(r:SkillInstallRequest,a:ApprovedAction):Promise<ActionResult>; registerService(r:ServiceRegistrationRequest,a:ApprovedAction):Promise<ActionResult>; deviceFlowInstructions():Promise<string[]>; nodeStatus():Promise<NodeStatusView>; stopNode(a:ApprovedAction):Promise<ActionResult>; beginEnrollment(a:ApprovedAction,o?:{controlPlane?:string}):Promise<EnrollmentInfo|ActionResult>; enrollmentStatus(id:string):Promise<EnrollmentInfo|null>; activeEnrollment():Promise<EnrollmentInfo|null>; cancelEnrollment(id:string):Promise<ActionResult>; meshDoctor():Promise<{checks:DoctorCheck[]}> }
function unwrap<T>(r:{ok:true;value:T}|{ok:false;error:{message:string}}):T { if(!r.ok) throw new Error(r.error.message); return r.value }
export function createMeshWebApi(ctx:Context):MeshWebApi { const r=ctx.remote.agentMeshWeb; return {snapshot:async()=>unwrap(await r.snapshot()),check:async()=>unwrap(await r.check()),startNode:async a=>unwrap(await r.startNode(a)),installSkill:async(q,a)=>unwrap(await r.installSkill(q,a)),registerService:async(q,a)=>unwrap(await r.registerService(q,a)),deviceFlowInstructions:async()=>unwrap(await r.deviceFlowInstructions()),nodeStatus:async()=>unwrap(await r.nodeStatus()),stopNode:async a=>unwrap(await r.stopNode(a)),beginEnrollment:async(a,o)=>unwrap(await r.beginEnrollment(a,o)),enrollmentStatus:async id=>unwrap(await r.enrollmentStatus(id)),activeEnrollment:async()=>unwrap(await r.activeEnrollment()),cancelEnrollment:async id=>unwrap(await r.cancelEnrollment(id)),meshDoctor:async()=>unwrap(await r.meshDoctor())} }
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

/** Onboarding wizard: the web answer to "am I on the mesh?" — the same
 * checks as `sam-mesh doctor`, rendered as steps with per-failure fixes. */
function WizardSection({api}:{api:MeshWebApi}) {
 const [checks,setChecks]=useState<DoctorCheck[]>()
 useEffect(()=>{ let live=true; const poll=async()=>{ try{ const r=await api.meshDoctor(); if(live) setChecks(r.checks) }catch{ if(live) setChecks(undefined) } }
  void poll(); const t=setInterval(()=>void poll(),5000); return ()=>{ live=false; clearInterval(t) } },[api])
 if(!checks) return null
 const failures=checks.filter(c=>!c.ok).length
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Onboarding</strong>
  <ol style={{margin:"6px 0 0",paddingLeft:20,display:"grid",gap:4}}>
   {checks.map(c=><li key={c.name} style={{color:c.ok?"var(--success,#4caf50)":"var(--danger,#e57373)"}}>
    {c.ok?"\u2713":"\u2717"} {c.name}{c.detail?` — ${c.detail}`:""}
    {!c.ok&&c.fix&&<code style={{display:"block",opacity:0.8,marginTop:2}}>{c.fix}</code>}
   </li>)}
  </ol>
  <small>{failures===0?"All checks pass — this machine is on the mesh.":`${failures} issue(s) — fixes above.`}</small>
 </div>
}

function NodeSection({api,onChanged}:{api:MeshWebApi;onChanged:()=>Promise<void>}) {
 const [status,setStatus]=useState<NodeStatusView>(); const [session,setSession]=useState<EnrollmentInfo|null>(null)
 const [note,setNote]=useState("")
 const refresh=useCallback(async()=>{ setStatus(await api.nodeStatus()) },[api])
 useEffect(()=>{ void refresh() },[refresh])
 useEffect(()=>{ void api.activeEnrollment().then(info=>{ if(info) setSession(info) }).catch(()=>undefined) },[api])
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
   <WizardSection api={api}/>
   <p style={{margin:0,opacity:0.75}}>{status.running?(status.managedByDsh?"Started by dsh — stops automatically when dsh stops.":"Running independently of dsh — use Stop node to shut it down."):status.enrolled?"Stopped — Start node brings it up (dsh-managed).":"Not enrolled."}</p>
   <dl style={{margin:0}}><dt>Binary</dt><dd>{status.installed?status.binaryPath:"sam-node not found on PATH"}</dd><dt>Data dir</dt><dd>{status.dataDir}</dd>{status.pid!==null&&<><dt>PID</dt><dd>{status.pid}</dd></>}</dl>
   <div>
    {!status.running&&status.enrolled&&<button style={button} onClick={()=>void act(()=>api.startNode(approve()))}>Start node (approved)</button>}{" "}
    {status.running&&<button style={button} onClick={()=>void act(()=>api.stopNode(approve()))}>Stop node (approved)</button>}{" "}
    {!status.enrolled&&status.installed&&!session&&<button style={button} onClick={()=>void begin()}>Enroll this machine (approved)</button>}
   </div>
   {session&&(session.state==="starting"||session.state==="awaiting_user")&&<div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:12}}>
    {session.mode==="bootstrap"?<p>Enrolling with the stored pre-shared token — no browser step needed…</p>
     :session.state==="starting"?<p>Contacting the control plane…</p>:<>
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

/** The agent-mesh settings section shape (mirrors the host namespace schema). */
interface MeshSettingsSection { autoStartNode?: boolean; autoBeginEnrollment?: boolean; stopNodeOnExit?: boolean; nodeControlPlane?: string; nodeEnrollmentCredentialRef?: string; tcpUrl?: string; timeoutMs?: number; preferSocket?: boolean; socketPath?: string | false }

const fieldRow:React.CSSProperties={display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"6px 0",borderBottom:"1px solid var(--border,#2a2a2a)"}
const textInput:React.CSSProperties={width:220,padding:"4px 8px",borderRadius:6,border:"1px solid var(--border,#444)",background:"var(--bg,#111)",color:"inherit",fontSize:13}

function Toggle({label,hint,value,onChange}:{label:string;hint:string;value:boolean;onChange:(v:boolean)=>void}) {
 return <div style={fieldRow}><div><div>{label}</div><small style={{opacity:0.65}}>{hint}</small></div>
  <input type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)} style={{width:16,height:16}}/></div> }

function TextField({label,hint,value,placeholder,onChange}:{label:string;hint:string;value:string;placeholder?:string;onChange:(v:string)=>void}) {
 return <div style={fieldRow}><div><div>{label}</div><small style={{opacity:0.65}}>{hint}</small></div>
  <input style={textInput} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)}/></div> }

/** Settings → Plugins → agent-mesh: every plugin knob as a form field. Writes
 * persist to settings.yaml through the settings scope; boot-time keys apply on
 * the next dsh start, decision-time keys (stopNodeOnExit, control plane) live. */
export function MeshConfigCard({scope}:{scope:SettingsScope<MeshSettingsSection>}) {
 const snap=useSyncExternalStore(scope.subscribe,()=>scope.getSnapshot())
 if(snap.status==="unavailable") return null
 if(snap.status==="loading"||!snap.value) return <section style={box}><header><h3 style={{margin:0}}>Agent Mesh</h3><small>Loading settings…</small></header></section>
 const v=snap.value
 const set=(field:string,value:unknown)=>{ void scope.set(field,value) }
 return <section style={box} data-testid="agent-mesh-config"><header><h3 style={{margin:0}}>Agent Mesh</h3>
  <small>Node lifecycle keys marked restart apply on the next dsh start; the others apply immediately.{snap.writable?"":" (read-only: the settings document is memory-mode)"}</small></header>
 <Toggle label="Auto-start node" hint="Start the enrolled sam-node when dsh boots (restart)" value={v.autoStartNode??true} onChange={x=>set("autoStartNode",x)}/>
 <Toggle label="Auto-begin enrollment" hint="On unenrolled machines, prepare the browser enrollment prompt at boot (restart)" value={v.autoBeginEnrollment??true} onChange={x=>set("autoBeginEnrollment",x)}/>
 <Toggle label="Stop node with dsh" hint="When dsh started the node, stop it on dsh shutdown (live)" value={v.stopNodeOnExit??true} onChange={x=>set("stopNodeOnExit",x)}/>
 <TextField label="Control plane" hint="Mesh to join at enrollment (live)" value={v.nodeControlPlane??""} placeholder="https://hub.sam-mesh.dev" onChange={x=>set("nodeControlPlane",x)}/>
 <TextField label="Enrollment credential ref" hint="Managed-store reference for pre-shared (unattended) enrollment; empty = browser flow (live)" value={v.nodeEnrollmentCredentialRef??""} placeholder="SAM_MESH_BOOTSTRAP" onChange={x=>set("nodeEnrollmentCredentialRef",x)}/>
 <TextField label="Node TCP URL" hint="Local node fallback endpoint (restart)" value={v.tcpUrl??""} placeholder="http://127.0.0.1:8080" onChange={x=>set("tcpUrl",x)}/>
 <TextField label="Node socket" hint="Unix socket path, or 'false' for TCP only (restart)" value={String(v.socketPath??"")} placeholder="~/.config/sam-mesh/sam.sock" onChange={x=>set("socketPath",x==="false"?false:x)}/>
 <Toggle label="Prefer socket" hint="Use the unix socket before TCP (restart)" value={v.preferSocket??true} onChange={x=>set("preferSocket",x)}/>
 <div style={fieldRow}><div><div>Request timeout (ms)</div><small style={{opacity:0.65}}>Mesh call timeout (restart)</small></div>
  <input style={{...textInput,width:110}} type="number" value={v.timeoutMs??30000} onChange={e=>set("timeoutMs",Number(e.target.value)||30000)}/></div>
 </section> }

export const name="agent-mesh-client"; export const inject=["slots","remote","settingsScope"] as const
export async function apply(ctx:Context):Promise<()=>Promise<void>> { const dispose=await ctx.remote.$mount(remoteContribution);const api=createMeshWebApi(ctx);ctx.slots.inject("settings.section",()=>ctx.slots.register({name:"settings.section",id:"agent-mesh",order:70,label:"Agent Mesh"},()=> <MeshSettingsCard api={api}/>))
 const configScope=ctx.settingsScope.bind<MeshSettingsSection>({namespace:"agent-mesh"})
 ctx.slots.inject("settings.plugin.item",()=>ctx.slots.register({name:"settings.plugin.item",key:"agent-mesh"},()=> <MeshConfigCard scope={configScope}/>))
 return dispose }
