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
import type { NodeStatusView, ServeStatusView, ServeConfigureRequest, RuntimeStatusView, RuntimePullStatusView } from "../web/host.js"
export interface BinaryOptionsView { options: Array<{ path: string; source: "env"|"bundled"|"path"; suggested: boolean; tag?: string }>; selected: string; auto: boolean }
export interface MeshWebApi { snapshot():Promise<MeshDashboardSnapshot>; check():Promise<MeshDashboardSnapshot>; startNode(a:ApprovedAction):Promise<ActionResult>; installSkill(r:SkillInstallRequest,a:ApprovedAction):Promise<ActionResult>; registerService(r:ServiceRegistrationRequest,a:ApprovedAction):Promise<ActionResult>; deviceFlowInstructions():Promise<string[]>; nodeStatus():Promise<NodeStatusView>; nodeBinaryOptions():Promise<BinaryOptionsView>; stopNode(a:ApprovedAction):Promise<ActionResult>; beginEnrollment(a:ApprovedAction,o?:{controlPlane?:string}):Promise<EnrollmentInfo|ActionResult>; enrollmentStatus(id:string):Promise<EnrollmentInfo|null>; activeEnrollment():Promise<EnrollmentInfo|null>; cancelEnrollment(id:string):Promise<ActionResult>; meshDoctor():Promise<{checks:DoctorCheck[]}>; pairRequests():Promise<{pairing:boolean;pending:{requestId:string;label:string;requestedAt:number}[]}>; approvePairRequest(id:string,a:ApprovedAction):Promise<ActionResult>; rejectPairRequest(id:string,a:ApprovedAction):Promise<ActionResult>; fleetDiscover():Promise<{fleets:{name:string;providers:number;peerIds:string[]}[];node:{running:boolean;enrolled:boolean;enrolledHub:string|null}}>; requestFleetPair(q:{serviceName:string;peerId?:string;label?:string},a:ApprovedAction):Promise<{sessionId?:string;ok:boolean;error?:string}>; fleetPairStatus(id:string):Promise<{state:string;fleet?:string;error?:string;notes?:string[]}>; inferenceServeStatus():Promise<ServeStatusView>; inferenceServeConfigure(r:ServeConfigureRequest,a:ApprovedAction):Promise<ActionResult>; runtimeStatus():Promise<RuntimeStatusView>; runtimePull(r:{model:string},a:ApprovedAction):Promise<{sessionId:string}>; runtimePullStatus(id:string):Promise<RuntimePullStatusView> }
function unwrap<T>(r:{ok:true;value:T}|{ok:false;error:{message:string}}):T { if(!r.ok) throw new Error(r.error.message); return r.value }
export function createMeshWebApi(ctx:Context):MeshWebApi { const r=ctx.remote.agentMeshWeb; return {snapshot:async()=>unwrap(await r.snapshot()),check:async()=>unwrap(await r.check()),startNode:async a=>unwrap(await r.startNode(a)),installSkill:async(q,a)=>unwrap(await r.installSkill(q,a)),registerService:async(q,a)=>unwrap(await r.registerService(q,a)),deviceFlowInstructions:async()=>unwrap(await r.deviceFlowInstructions()),nodeStatus:async()=>unwrap(await r.nodeStatus()),nodeBinaryOptions:async()=>unwrap(await r.nodeBinaryOptions()),stopNode:async a=>unwrap(await r.stopNode(a)),beginEnrollment:async(a,o)=>unwrap(await r.beginEnrollment(a,o)),enrollmentStatus:async id=>unwrap(await r.enrollmentStatus(id)),activeEnrollment:async()=>unwrap(await r.activeEnrollment()),cancelEnrollment:async id=>unwrap(await r.cancelEnrollment(id)),meshDoctor:async()=>unwrap(await r.meshDoctor()),pairRequests:async()=>unwrap(await r.pairRequests()),approvePairRequest:async(id,a)=>unwrap(await r.approvePairRequest(id,a)),rejectPairRequest:async(id,a)=>unwrap(await r.rejectPairRequest(id,a)),fleetDiscover:async()=>unwrap(await r.fleetDiscover()),requestFleetPair:async(q,a)=>unwrap(await r.requestFleetPair(q,a)),fleetPairStatus:async id=>unwrap(await r.fleetPairStatus(id)),inferenceServeStatus:async()=>unwrap(await r.inferenceServeStatus()),inferenceServeConfigure:async(q,a)=>unwrap(await r.inferenceServeConfigure(q,a)),runtimeStatus:async()=>unwrap(await r.runtimeStatus()),runtimePull:async(q,a)=>unwrap(await r.runtimePull(q,a)),runtimePullStatus:async id=>unwrap(await r.runtimePullStatus(id))} }
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


/** Fleet pairing approvals: join requests from machines that discovered this
 * fleet in the public swarm. The operator's human gate, in the browser. */

type PairView = {sessionId:string;fleet:string;state:string;error?:string;notes?:string[]}

/** Join a fleet FROM this machine, entirely in the browser: discover fleets
 * in the swarm, request to pair, watch the operator's approval land. The
 * host owns keys, polling, sealed-invite opening, and provisioning. */
function JoinFleetSection({api}:{api:MeshWebApi}) {
 const [result,setResult]=useState<{fleets:{name:string;providers:number;peerIds:string[]}[];node:{running:boolean;enrolled:boolean;enrolledHub:string|null}}>()
 const [session,setSession]=useState<PairView>()
 const [note,setNote]=useState("")
 const discover=async()=>{ setNote(""); try{ setResult(await api.fleetDiscover()) }catch(e){ setNote(e instanceof Error?e.message:String(e)) } }
 useEffect(()=>{ if(!session||session.state!=="waiting") return
  const t=setInterval(async()=>{ const s=await api.fleetPairStatus(session.sessionId); setSession({...session,...s}) },2000)
  return ()=>clearInterval(t) },[session?.sessionId,session?.state])
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const request=async(serviceName:string)=>{ const r=await api.requestFleetPair({serviceName},approve())
  if(r.ok&&r.sessionId) setSession({sessionId:r.sessionId,fleet:serviceName,state:"waiting"}); else setNote(r.error??"request failed") }
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Join a fleet</strong>{" "}<button style={button} onClick={()=>void discover()}>Discover fleets</button>
  {note&&<p role="alert" style={{margin:"4px 0"}}>{note}</p>}
  {session&&session.state==="waiting"&&<p style={{margin:"6px 0 0"}}>Waiting for an operator to approve your request to <code>{session.fleet}</code>… (they approve from their card or sam-mesh fleet approvals)</p>}
  {session&&session.state==="complete"&&<div style={{margin:"6px 0 0"}}><p style={{margin:0}}>✓ You hold the <code>{session.fleet}</code> capability.</p><ul style={{margin:"4px 0 0",paddingLeft:18}}>{session.notes?.map((n,i)=><li key={i}><small>{n}</small></li>)}</ul></div>}
  {session&&session.state==="failed"&&<p role="alert" style={{margin:"6px 0 0"}}>Pairing failed: {session.error}</p>}
  {result&&!result.node.running&&<p role="alert" style={{margin:"6px 0 0"}}>Your node is not running — enroll and start it in the <strong>Mesh node</strong> section above, then discover again.</p>}
  {result&&result.node.running&&!result.node.enrolled&&<p role="alert" style={{margin:"6px 0 0"}}>Your node is running but not enrolled — use <strong>Mesh node → Enroll this machine</strong> above, then discover again.</p>}
  {result&&result.node.running&&result.node.enrolled&&result.fleets.length===0&&<p style={{margin:"6px 0 0",opacity:0.7}}>No fleets visible on <code>{result.node.enrolledHub ?? "your hub"}</code>. If you expected one, check it announces on THIS hub — the card's doctor shows where you are enrolled{result.node.enrolledHub?.includes("hub.sam-mesh.dev")?"":" (you are NOT on the public hub — a stale private-hub identity sees a different swarm)"}.</p>}
  {result&&result.node.running&&result.node.enrolled&&result.fleets.length>0&&<ul style={{margin:"6px 0 0",paddingLeft:18,display:"grid",gap:4}}>
   {result.fleets.map(f=><li key={f.name}><code>{f.name}</code>{" "}<small>{f.providers} provider{f.providers===1?"":"s"}</small>{" "}
    <button style={button} disabled={session?.state==="waiting"} onClick={()=>void request(f.name)}>Request to join</button></li>)}
  </ul>}
 </div>
}

function PairingSection({api}:{api:MeshWebApi}) {
 const [state,setState]=useState<{pairing:boolean;pending:{requestId:string;label:string;requestedAt:number}[]}>()
 const [note,setNote]=useState("")
 useEffect(()=>{ let live=true; const poll=async()=>{ try{ const r=await api.pairRequests(); if(live) setState(r) }catch{ if(live) setState(undefined) } }
  void poll(); const t=setInterval(()=>void poll(),3000); return ()=>{ live=false; clearInterval(t) } },[api])
 if(!state) return null
 if(!state.pairing) return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Fleet pairing</strong><p style={{margin:"4px 0 0",opacity:0.7}}>Not armed — set a capability credential ref on the task service to let discovered machines request to join.</p>
 </div>
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const act=async(f:()=>Promise<ActionResult>)=>{ const r=await f(); setNote(r.ok?r.message:r.error) }
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Fleet pairing</strong>{" "}<small>{state.pending.length===0?"no pending requests":`${state.pending.length} pending`}</small>
  {note&&<p role="status" style={{margin:"4px 0"}}>{note}</p>}
  {state.pending.length>0&&<ul style={{margin:"6px 0 0",paddingLeft:18,display:"grid",gap:6}}>
   {state.pending.map(r=><li key={r.requestId}>
    <code>{r.label}</code>{" "}<small>id {r.requestId.slice(0,10)}… · {Math.max(0,Math.round((Date.now()-r.requestedAt)/1000))}s ago</small>{" "}
    <button style={button} onClick={()=>void act(()=>api.approvePairRequest(r.requestId,approve()))}>Approve</button>{" "}
    <button style={button} onClick={()=>void act(()=>api.rejectPairRequest(r.requestId,approve()))}>Reject</button>
   </li>)}
  </ul>}
  <small>Approve only machines you expected — approval delivers the fleet capability, sealed to the requester.</small>
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
   <PairingSection api={api}/>
   <JoinFleetSection api={api}/>
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
interface MeshSettingsSection { autoStartNode?: boolean; autoBeginEnrollment?: boolean; stopNodeOnExit?: boolean; nodeControlPlane?: string; nodeBinary?: string; nodeEnrollmentCredentialRef?: string; tcpUrl?: string; timeoutMs?: number; preferSocket?: boolean; socketPath?: string | false }

const fieldRow:React.CSSProperties={display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"6px 0",borderBottom:"1px solid var(--border,#2a2a2a)"}
const textInput:React.CSSProperties={width:220,padding:"4px 8px",borderRadius:6,border:"1px solid var(--border,#444)",background:"var(--bg,#111)",color:"inherit",fontSize:13}

function Toggle({label,hint,value,onChange}:{label:string;hint:string;value:boolean;onChange:(v:boolean)=>void}) {
 return <div style={fieldRow}><div><div>{label}</div><small style={{opacity:0.65}}>{hint}</small></div>
  <input type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)} style={{width:16,height:16}}/></div> }

function TextField({label,hint,value,placeholder,onChange}:{label:string;hint:string;value:string;placeholder?:string;onChange:(v:string)=>void}) {
 return <div style={fieldRow}><div><div>{label}</div><small style={{opacity:0.65}}>{hint}</small></div>
  <input style={textInput} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)}/></div> }

/** sam-node binary picker: every usable binary on the machine, with the
 * kit's suggestion preselected. "Auto" (empty value) follows the suggestion.
 * The choice is written to settings and applies on the next dsh start. */
function BinaryField({api,value,onChange}:{api:MeshWebApi;value:string;onChange:(v:string)=>void}) {
 const [view,setView]=useState<BinaryOptionsView>()
 useEffect(()=>{ let live=true; void api.nodeBinaryOptions().then(v=>{ if(live) setView(v) }).catch(()=>undefined); return()=>{live=false} },[api])
 if(!view||view.options.length===0) return null
 const suggested=view.options.find(o=>o.suggested)
 const label=(o:{path:string;source:string;tag?:string})=>`${o.path}${o.source==="bundled"?` (bundled${o.tag?` ${o.tag}`:""})`:o.source==="env"?" (SAM_NODE)":""}`
 return <div style={fieldRow}><div><div>sam-node binary</div><small style={{opacity:0.65}}>Which sam-node this dsh runs (restart){suggested?` — suggested: ${label(suggested)}`:""}</small></div>
  <select style={textInput} value={view.auto?"":value} onChange={e=>onChange(e.target.value)}>
   <option value="">Auto — {suggested?label(suggested):"manager's suggestion"}</option>
   {view.options.map(o=><option key={o.path} value={o.path}>{label(o)}{o.suggested?" ★":""}</option>)}
  </select></div> }

/** Settings → Plugins → agent-mesh: every plugin knob as a form field. Writes
 * persist to settings.yaml through the settings scope; boot-time keys apply on
 * the next dsh start, decision-time keys (stopNodeOnExit, control plane) live. */
export 

/** Built-in-runtime fields: vendored-binary status, model store picker, HF pull with progress. */
function RuntimeFields({api,runtime,setRuntime}:{api:MeshWebApi;runtime:string;setRuntime:(v:string)=>void}) {
 const [status,setStatus]=useState<RuntimeStatusView>()
 const [pullSpec,setPullSpec]=useState("")
 const [pull,setPull]=useState<RuntimePullStatusView>()
 const load=useCallback(async()=>{ try{ setStatus(await api.runtimeStatus()) }catch{ setStatus(undefined) } },[api])
 useEffect(()=>{ void load() },[load])
 useEffect(()=>{ if(pull?.state!=="running") return; const t=setInterval(async()=>{ /* polled by the caller via session */ },1000); return()=>clearInterval(t) },[pull?.state])
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const startPull=async()=>{ const {sessionId}=await api.runtimePull({model:pullSpec},approve()); setPull({state:"running",downloaded:0}); const tick=async()=>{ const s=await api.runtimePullStatus(sessionId); setPull(s); if(s.state==="running") setTimeout(()=>void tick(),1000); else if(s.state==="done"){ setRuntime(pullSpec); await load() } }; void tick() }
 return <>
  <div style={fieldRow}><div><div>Built-in runtime</div><small style={{opacity:0.65}}>{status?(status.available?`llama.cpp ${status.tag} — carried by the package`:`unavailable: ${status.error}`):"checking…"}</small></div></div>
  {(status?.models.length??0)>0&&<div style={fieldRow}><div><div>Downloaded models</div><small style={{opacity:0.65}}>Pick one to serve</small></div>
   <select style={textInput} value={status!.models.some(m=>runtime.includes(m.file.replace(/\.gguf$/i,"")))?runtime:""} onChange={e=>setRuntime(e.target.value)}>
    <option value="">—</option>
    {status!.models.map(m=><option key={m.file} value={m.file.replace(/\.gguf$/i,"")}>{m.file} ({(m.bytes/1e9).toFixed(2)} GB)</option>)}
   </select></div>}
  <div style={fieldRow}><div><div>Model (Hugging Face)</div><small style={{opacity:0.65}}>org/repo, org/repo:quant, or org/repo/file.gguf</small></div>
   <input style={textInput} value={runtime} placeholder="unsloth/SmolLM2-135M-Instruct-GGUF:Q8_0" onChange={e=>setRuntime(e.target.value)}/></div>
  <div style={{display:"flex",gap:8,alignItems:"center"}}>
   <input style={{...textInput,flex:1}} value={pullSpec} placeholder="org/repo:quant to download" onChange={e=>setPullSpec(e.target.value)}/>
   <button style={button} disabled={!pullSpec.trim()||pull?.state==="running"} onClick={()=>void startPull()}>Download</button>
  </div>
  {pull&&<small style={{opacity:0.75}}>{pull.state==="running"?`downloading… ${(pull.downloaded/1e9).toFixed(2)} GB${pull.total?` of ${(pull.total/1e9).toFixed(2)} GB (${Math.round(pull.downloaded/pull.total*100)}%)`:""}`:pull.state==="done"?`downloaded: ${pull.path}`:`download failed: ${pull.error}`}</small>}
 </>
}

/** Share-your-models section: detected backends, one-click serve, live roster.
 *  Writes the managed patch block via an approved remote; a dsh restart applies it. */
function ServeSection({api}:{api:MeshWebApi}) {
 const [status,setStatus]=useState<ServeStatusView>()
 const [target,setTarget]=useState("auto")
 const [name,setName]=useState("dsh-mesh-inference")
 const [allowlist,setAllowlist]=useState("")
 const [notice,setNotice]=useState("")
 const [mode,setMode]=useState<"external"|"runtime">("external")
 const [runtime,setRuntime]=useState("")
 const load=useCallback(async()=>{ try{ const s=await api.inferenceServeStatus(); setStatus(s); if(s.configured){ setTarget(s.target); setName(s.announceName); setAllowlist(s.modelAllowlist.join(", ")); if(s.runtimeModel){ setMode("runtime"); setRuntime(s.runtimeModel) } } }catch{ setStatus(undefined) } },[api])
 useEffect(()=>{ void load() },[load])
 if(!status) return null
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const present=status.backends.filter(b=>b.present)
 const act=async(f:()=>Promise<ActionResult>)=>{ const r=await f(); setNotice(r.ok?r.message:r.error); await load() }
 return <>
  <div style={fieldRow}><div><div>Share models with the fleet</div><small style={{opacity:0.65}}>
   {status.rowState==="error"?`Serve error — ${status.rowDetail}`:status.rowState==="starting"?`Starting — ${status.rowDetail}`:status.running?`Serving ${status.models.length} model${status.models.length===1?"":"s"} as ${status.announceName}`:status.configured?"Configured — applies on restart":"Off — models stay local"}
   {present.length>0?` — detected: ${present.map(b=>b.name).join(", ")}`:" — no local backend detected"}</small></div></div>
  {status.running&&status.models.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6}}>{status.models.slice(0,12).map(m=><code key={m} style={{fontSize:11,padding:"2px 6px",border:"1px solid var(--border,#444)",borderRadius:6}}>{m}</code>)}{status.models.length>12&&<small style={{opacity:0.65}}>+{status.models.length-12} more</small>}</div>}
  <div style={fieldRow}><div><div>Source</div><small style={{opacity:0.65}}>Serve an existing backend, or a model on the built-in runtime</small></div>
   <select style={textInput} value={mode} onChange={e=>setMode(e.target.value as "external"|"runtime")}>
    <option value="external">Existing backend (Ollama, vLLM, …)</option>
    <option value="runtime">Built-in runtime — nothing to install</option>
   </select></div>
  {mode==="external"&&<div style={fieldRow}><div><div>Backend</div><small style={{opacity:0.65}}>OpenAI-compatible endpoint to gate (auto = detect)</small></div>
   <select style={textInput} value={target} onChange={e=>setTarget(e.target.value)}>
    <option value="auto">Auto — detect local backend</option>
    {present.map(b=><option key={b.url} value={b.url}>{b.name} — {b.url}</option>)}
    {target!=="auto"&&!present.some(b=>b.url===target)&&<option value={target}>{target} (configured)</option>}
   </select></div>}
  {mode==="runtime"&&<RuntimeFields api={api} runtime={runtime} setRuntime={setRuntime}/>}
  <div style={fieldRow}><div><div>Mesh name</div><small style={{opacity:0.65}}>Fleet-wide service name for these models</small></div>
   <input style={textInput} value={name} onChange={e=>setName(e.target.value)}/></div>
  <div style={fieldRow}><div><div>Model allowlist</div><small style={{opacity:0.65}}>Comma-separated; empty = everything the backend offers</small></div>
   <input style={textInput} value={allowlist} placeholder="gemma-4-12b, qwen3.8-27b-int8" onChange={e=>setAllowlist(e.target.value)}/></div>
  <div style={{display:"flex",gap:8,alignItems:"center"}}>
   <button style={button} onClick={()=>void act(()=>api.inferenceServeConfigure({enabled:true,target:mode==="runtime"?"":target,announceName:name,modelAllowlist:allowlist.split(",").map(s=>s.trim()).filter(Boolean),runtimeModel:mode==="runtime"?runtime:"",runtimeAlias:""},approve()))}>{status.configured?"Update serve row":"Start sharing"}</button>
   {status.configured&&<button style={button} onClick={()=>void act(()=>api.inferenceServeConfigure({enabled:false},approve()))}>Stop sharing</button>}
   {notice&&<small style={{opacity:0.75}}>{notice}</small>}
  </div>
 </>
}

function MeshConfigCard({scope,api}:{scope:SettingsScope<MeshSettingsSection>;api?:MeshWebApi}) {
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
 {api&&<BinaryField api={api} value={v.nodeBinary??""} onChange={x=>set("nodeBinary",x)}/>}
 {api&&<ServeSection api={api}/>}
 <TextField label="Enrollment credential ref" hint="Managed-store reference for pre-shared (unattended) enrollment; empty = browser flow (live)" value={v.nodeEnrollmentCredentialRef??""} placeholder="SAM_MESH_BOOTSTRAP" onChange={x=>set("nodeEnrollmentCredentialRef",x)}/>
 <TextField label="Node TCP URL" hint="Local node fallback endpoint (restart)" value={v.tcpUrl??""} placeholder="http://127.0.0.1:8080" onChange={x=>set("tcpUrl",x)}/>
 <TextField label="Node socket" hint="Unix socket path, or 'false' for TCP only (restart)" value={String(v.socketPath??"")} placeholder="~/.config/sam-mesh/sam.sock" onChange={x=>set("socketPath",x==="false"?false:x)}/>
 <Toggle label="Prefer socket" hint="Use the unix socket before TCP (restart)" value={v.preferSocket??true} onChange={x=>set("preferSocket",x)}/>
 <div style={fieldRow}><div><div>Request timeout (ms)</div><small style={{opacity:0.65}}>Mesh call timeout (restart)</small></div>
  <input style={{...textInput,width:110}} type="number" value={v.timeoutMs??30000} onChange={e=>set("timeoutMs",Number(e.target.value)||30000)}/></div>
 </section> }

/** The OUTER plugin must NOT inject remote.agentMeshWeb: that namespace
 * service only exists once our own apply() mounts the contribution — declaring
 * it here deadlocks the fiber against itself (the harness separates mounters
 * from consumers across packages; a single package splits via a child plugin). */
export const name="agent-mesh-client"; export const inject=["slots","remote","settingsScope"] as const
export async function apply(ctx:Context):Promise<()=>Promise<void>> { const dispose=await ctx.remote.$mount(remoteContribution)
 const ui=ctx.plugin({name:"agent-mesh-ui",inject:["slots","remote","remote.agentMeshWeb","settingsScope"],apply:(uiCtx:Context)=>{
  const api=createMeshWebApi(uiCtx);uiCtx.slots.inject("settings.section",()=>uiCtx.slots.register({name:"settings.section",id:"agent-mesh",order:70,label:"Agent Mesh"},()=> <MeshSettingsCard api={api}/>))
  const configScope=uiCtx.settingsScope.bind<MeshSettingsSection>({namespace:"agent-mesh"})
  uiCtx.slots.inject("settings.plugin.item",()=>uiCtx.slots.register({name:"settings.plugin.item",key:"agent-mesh"},()=> <MeshConfigCard scope={configScope} api={api}/>))
 }})
 return async()=>{ await ui.dispose(); await dispose() } }
