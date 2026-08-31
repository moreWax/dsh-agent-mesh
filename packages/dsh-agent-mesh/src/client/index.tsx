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
export interface MeshWebApi { snapshot():Promise<MeshDashboardSnapshot>; check():Promise<MeshDashboardSnapshot>; startNode(a:ApprovedAction):Promise<ActionResult>; installSkill(r:SkillInstallRequest,a:ApprovedAction):Promise<ActionResult>; registerService(r:ServiceRegistrationRequest,a:ApprovedAction):Promise<ActionResult>; deviceFlowInstructions():Promise<string[]>; nodeStatus():Promise<NodeStatusView>; nodeBinaryOptions():Promise<BinaryOptionsView>; stopNode(a:ApprovedAction):Promise<ActionResult>; beginEnrollment(a:ApprovedAction,o?:{controlPlane?:string}):Promise<EnrollmentInfo|ActionResult>; enrollmentStatus(id:string):Promise<EnrollmentInfo|null>; activeEnrollment():Promise<EnrollmentInfo|null>; cancelEnrollment(id:string):Promise<ActionResult>; meshDoctor():Promise<{checks:DoctorCheck[]}>; pairRequests():Promise<{pairing:boolean;pending:{requestId:string;label:string;requestedAt:number}[]}>; approvePairRequest(id:string,a:ApprovedAction):Promise<ActionResult>; rejectPairRequest(id:string,a:ApprovedAction):Promise<ActionResult>; fleetAdminRequests(q:{serviceName?:string;peerId?:string}):Promise<{ok:boolean;pending?:{requestId:string;label:string;requestedAt?:string}[];error?:string}>; fleetAdminApprove(q:{requestId:string;serviceName?:string;peerId?:string},a:ApprovedAction):Promise<ActionResult>; fleetAdminReject(q:{requestId:string;serviceName?:string;peerId?:string},a:ApprovedAction):Promise<ActionResult>; fleetDiscover():Promise<{fleets:{name:string;providers:number;peerIds:string[];description?:string}[];node:{running:boolean;enrolled:boolean;enrolledHub:string|null};needsReenroll:boolean;membership:{state:"valid"|"stale"|"unpaired";detail?:string}}>; requestFleetPair(q:{serviceName:string;peerId?:string;label?:string},a:ApprovedAction):Promise<{sessionId?:string;ok:boolean;error?:string}>; fleetPairStatus(id:string):Promise<{state:string;fleet?:string;error?:string;notes?:string[]}>; inferenceServeStatus():Promise<ServeStatusView>; inferenceServeConfigure(r:ServeConfigureRequest,a:ApprovedAction):Promise<ActionResult>; runtimeStatus():Promise<RuntimeStatusView>; runtimePull(r:{model:string},a:ApprovedAction):Promise<{sessionId:string}>; runtimePullStatus(id:string):Promise<RuntimePullStatusView>; fleetAdminMembers(q:{serviceName?:string;peerId?:string}):Promise<{ok:boolean;members?:{id:string;name:string;scopes:string[];createdAt:string;note?:string}[];error?:string}>; fleetAdminRevoke(q:{id:string;serviceName?:string;peerId?:string},a:ApprovedAction):Promise<ActionResult>; fleetInviteCreate(q:{ttlMs?:number;note?:string;serviceName?:string;peerId?:string},a:ApprovedAction):Promise<{ok:boolean;code?:string;expiresAt?:number;error?:string}>; inferenceSteerStatus(q:{row?:string;serviceName?:string;peerId?:string}):Promise<{ok:boolean;rows?:Record<string,{systemPrompt?:string;temperature?:number;topP?:number;maxTokens?:number}>;error?:string}>; peerExec(q:{command:string;memberId?:string;timeoutMs?:number},a:ApprovedAction):Promise<{ok:boolean;member?:string;exit?:number|null;stdout?:string;stderr?:string;timedOut?:boolean;error?:string}>; inferenceSteerApply(q:{row?:string;systemPrompt?:string;temperature?:number;topP?:number;maxTokens?:number;clear?:boolean;serviceName?:string;peerId?:string},a:ApprovedAction):Promise<ActionResult>; core?: unknown; /* scaffold-anchor: api-type */ }
function unwrap<T>(r:{ok:true;value:T}|{ok:false;error:{message:string}}):T { if(!r.ok) throw new Error(r.error.message); return r.value }
export function createMeshWebApi(ctx:Context):MeshWebApi { const r=ctx.remote.agentMeshWeb; return {core:r, snapshot:async()=>unwrap(await r.snapshot()),check:async()=>unwrap(await r.check()),startNode:async a=>unwrap(await r.startNode(a)),installSkill:async(q,a)=>unwrap(await r.installSkill(q,a)),registerService:async(q,a)=>unwrap(await r.registerService(q,a)),deviceFlowInstructions:async()=>unwrap(await r.deviceFlowInstructions()),nodeStatus:async()=>unwrap(await r.nodeStatus()),nodeBinaryOptions:async()=>unwrap(await r.nodeBinaryOptions()),stopNode:async a=>unwrap(await r.stopNode(a)),beginEnrollment:async(a,o)=>unwrap(await r.beginEnrollment(a,o)),enrollmentStatus:async id=>unwrap(await r.enrollmentStatus(id)),activeEnrollment:async()=>unwrap(await r.activeEnrollment()),cancelEnrollment:async id=>unwrap(await r.cancelEnrollment(id)),meshDoctor:async()=>unwrap(await r.meshDoctor()),pairRequests:async()=>unwrap(await r.pairRequests()),approvePairRequest:async(id,a)=>unwrap(await r.approvePairRequest(id,a)),rejectPairRequest:async(id,a)=>unwrap(await r.rejectPairRequest(id,a)),fleetAdminRequests:async q=>unwrap(await r.fleetAdminRequests(q)),fleetAdminApprove:async(q,a)=>unwrap(await r.fleetAdminApprove(q,a)),fleetAdminReject:async(q,a)=>unwrap(await r.fleetAdminReject(q,a)),fleetDiscover:async()=>unwrap(await r.fleetDiscover()),requestFleetPair:async(q,a)=>unwrap(await r.requestFleetPair(q,a)),fleetPairStatus:async id=>unwrap(await r.fleetPairStatus(id)),inferenceServeStatus:async()=>unwrap(await r.inferenceServeStatus()),inferenceServeConfigure:async(q,a)=>unwrap(await r.inferenceServeConfigure(q,a)),runtimeStatus:async()=>unwrap(await r.runtimeStatus()),runtimePull:async(q,a)=>unwrap(await r.runtimePull(q,a)),runtimePullStatus:async id=>unwrap(await r.runtimePullStatus(id)),fleetAdminMembers:async q=>unwrap(await r.fleetAdminMembers(q)),fleetAdminRevoke:async(q,a)=>unwrap(await r.fleetAdminRevoke(q,a)),fleetInviteCreate:async(q,a)=>unwrap(await r.fleetInviteCreate(q,a)),inferenceSteerStatus:async q=>unwrap(await r.inferenceSteerStatus(q)),peerExec:async(q,a)=>unwrap(await r.peerExec(q,a)),inferenceSteerApply:async(q,a)=>unwrap(await r.inferenceSteerApply(q,a))/* scaffold-anchor: api-impl */} }
const box:React.CSSProperties={border:"1px solid var(--border,#444)",borderRadius:10,padding:16,display:"grid",gap:12}; const button:React.CSSProperties={padding:"7px 12px",borderRadius:6,cursor:"pointer"}; const input:React.CSSProperties={padding:"6px 8px",borderRadius:6};
function Json({value}:{value:unknown}) { return <pre style={{whiteSpace:"pre-wrap",maxHeight:220,overflow:"auto",fontSize:12}}>{JSON.stringify(value,null,2)}</pre> }
const chip:React.CSSProperties={display:"inline-flex",alignItems:"center",gap:6,padding:"3px 10px",border:"1px solid var(--border,#444)",borderRadius:999,fontSize:12}
const panel:React.CSSProperties={border:"1px solid var(--border,#444)",borderRadius:8,padding:10,display:"grid",gap:6}

/** Copy-to-clipboard with inline confirmation; clipboard API may be absent on
 * non-secure origins, so failures degrade to a no-op rather than an error. */
/** Live urgency hint for the device flow: codes live ~5 minutes; the strip
 * counts up and turns red as expiry approaches. A session that self-retries
 * (A3) resets it by replacing the code — remount on userCode change. */
function EnrollCountdown() {
 const [seconds,setSeconds]=useState(0)
 useEffect(()=>{ const t=setInterval(()=>setSeconds(s=>s+1),1000); return ()=>clearInterval(t) },[])
 const left=Math.max(0,300-seconds)
 const urgent=left<90
 return <small role="status" style={{color:urgent?"#e07070":"inherit",opacity:urgent?1:0.75}}>
  {left>0?`code expires in ~${Math.floor(left/60)}:${String(left%60).padStart(2,"0")}${urgent?" — approve now":""}`:"code expiring — a fresh one issues automatically if it lapses"}
 </small>
}

function CopyButton({text}:{text:string}) { const [copied,setCopied]=useState(false)
 return <button style={{...button,padding:"2px 8px",fontSize:12}} onClick={()=>{ const nav=(globalThis as {navigator?:{clipboard?:{writeText(t:string):Promise<void>}}}).navigator; if(!nav?.clipboard) return
  void nav.clipboard.writeText(text).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),1500) }).catch(()=>undefined) }}>{copied?"\u2713 copied":"copy"}</button> }

/** One-line chip content for a snapshot service/tool entry. Both probes return
 * loosely-typed mesh records, so every field is extracted defensively. */
export function chipView(kind:"services"|"tools",entry:unknown):{name:string;meta:string} {
 const o=(entry&&typeof entry==="object"?entry:{}) as Record<string,unknown>
 const str=(v:unknown):string|undefined=>typeof v==="string"&&v.trim()?v.trim():undefined
 if(kind==="services") return { name:str(o.name)??str(o.id)??"(unnamed service)", meta:[str(o.protocol),str(o.endpoint)].filter(Boolean).join(" \u00b7 ") }
 const svc=str(o.service_name); const peer=str(o.peer_id)
 return { name:str(o.tool_name)??str(o.name)??"(unnamed tool)", meta:[svc?`svc ${svc}`:undefined,peer?`peer ${peer.slice(0,10)}\u2026`:undefined].filter(Boolean).join(" \u00b7 ") }
}

/** Model roster view-model: group by the serving peer (owned_by) when the
 * snapshot carries it; badge rows served by the LOCAL serve row with the
 * row's live state. Missing data degrades to a single unbadged group. */
export interface ModelRow { id:string; badge:"warming"|"live"|"error"|null }
export interface ModelGroup { name:string; thisMachine:boolean; rows:ModelRow[] }
export function groupModels(models:unknown[],serve?:{models:string[];rowState?:string|undefined;announceName?:string|undefined}|null):ModelGroup[] {
 const rows=(Array.isArray(models)?models:[]).map(m=>{ const o=(m&&typeof m==="object"?m:{}) as Record<string,unknown>
  return { id:typeof o.id==="string"?o.id:String(JSON.stringify(m)), by:typeof o.owned_by==="string"?o.owned_by:"" } })
 const local=new Set(serve?.models??[])
 const badgeOf=(id:string):ModelRow["badge"]=>{ if(!local.has(id)) return null; return serve?.rowState==="starting"?"warming":serve?.rowState==="error"?"error":"live" }
 const anyBy=rows.some(r=>r.by)
 const groups=new Map<string,ModelRow[]>()
 for(const r of rows){ const key=anyBy?(r.by||"unknown source"):"mesh"; groups.set(key,[...(groups.get(key)??[]),{id:r.id,badge:badgeOf(r.id)}]) }
 return [...groups.entries()].map(([name,rs])=>({ name, thisMachine:rs.length>0&&rs.every(r=>local.has(r.id)), rows:rs })) }

/** First-run wizard view-model: derive the checklist from live mesh state.
 * Pure, so the step logic is unit-tested without a DOM. */
export interface WizardFacts { installed:boolean; enrolled:boolean; running:boolean; pairing:boolean; fleets?:{name:string;providers:number;peerIds:string[]}[]|undefined; peers?:number|undefined; models?:number|undefined; ownPeer?:string|undefined; joinedFleet?:string|undefined }
export type WizardStepId="enroll"|"run"|"fleet"|"ready"
export interface WizardStep { id:WizardStepId; label:string; done:boolean; current:boolean; error?:string|undefined; fix?:string|undefined; detail?:string|undefined }
export function wizardSteps(f:WizardFacts):WizardStep[] {
 const providerFleet=f.ownPeer&&f.fleets?f.fleets.find(x=>x.peerIds.includes(f.ownPeer!))?.name:undefined
 const membership=f.joinedFleet??providerFleet??(f.pairing?"a fleet you host":undefined)
 const discovered=f.fleets!==undefined
 const ready=discovered&&((f.fleets?.length??0)>0||(f.models??0)>0||(f.peers??0)>0)
 const steps:WizardStep[]=[
  { id:"enroll", label:"Node installed & enrolled", done:f.enrolled, current:false,
    ...(!f.installed?{ error:"sam-node binary not found on this machine", fix:"install sam-node, or pick a binary under Settings \u2192 Plugins \u2192 Agent Mesh \u2192 sam-node binary." }
     :!f.enrolled?{ detail:"sam-node is present \u2014 enrollment authorizes this machine on the hub" }:{}) },
  { id:"run", label:"Node running", done:f.running, current:false, ...(!f.running&&f.enrolled?{ detail:"enrolled \u2014 the daemon is stopped" }:{}) },
  { id:"fleet", label:"Joined a fleet", done:!!membership, current:false, ...(membership?{ detail:`member of ${membership}` }:{}) },
  { id:"ready", label:"Capability ready", done:ready, current:false,
    ...(!ready&&discovered?{ detail:"on the mesh, but no fleet services, peers, or models are visible yet" }:{} ) },
 ]
 const current=steps.find(s=>!s.done)
 return steps.map(s=>s===current?{...s,current:true}:s) }

const peerCount=(mesh:unknown):number|undefined=>{ const c=(mesh&&typeof mesh==="object"?(mesh as Record<string,unknown>).connected_peers:undefined); return typeof c==="number"?c:Array.isArray(c)?c.length:undefined }
const ownPeerId=(mesh:unknown):string|undefined=>{ const p=(mesh&&typeof mesh==="object"?(mesh as Record<string,unknown>).router_peer_id:undefined); return typeof p==="string"?p:undefined }
export function MeshSettingsCard({api}:{api:MeshWebApi}) { const [s,setS]=useState<MeshDashboardSnapshot>(); const [error,setError]=useState(""); const [notice,setNotice]=useState(""); const load=useCallback(async()=>{setError("");try{setS(await api.snapshot())}catch(e){setError(e instanceof Error?e.message:String(e))}},[api]); useEffect(()=>{void load()},[load]);
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"}); const act=async(f:()=>Promise<ActionResult>)=>{const result=await f();setNotice(result.ok?result.message:result.error);await load()};
 return <section style={box} data-testid="agent-mesh-settings"><header><h2 style={{margin:0}}>Agent Mesh</h2><small>Read-only status; mutations run only after the button you select.</small></header>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 <div><button style={button} onClick={()=>void load()}>Check connection</button>{" "}<button style={button} onClick={()=>void act(()=>api.startNode(approve()))}>Start node (approved)</button>{" "}<button style={button} onClick={()=>void api.deviceFlowInstructions().then(x=>setNotice(x.join("\n")))}>Enrollment instructions</button></div>
 <WizardSection api={api} onChanged={load}/>
 <NodeSection api={api} onChanged={load}/>
 {s&&<><dl><dt>Transport</dt><dd>{s.transport.kind}: {s.transport.endpoint}</dd><dt>Peer ID / router / peers / DHT / token / connectivity</dt><dd><Json value={{mesh:s.mesh,network:s.network,token:s.token}}/></dd></dl>
 <ChipSection kind="services" items={s.services}/>
 <ChipSection kind="tools" items={s.tools}/>
 <ModelRoster api={api} models={s.models}/>
 {(["failures","tasks","logs"] as const).map(k=><details key={k}><summary>{k} ({s[k].length})</summary><Json value={s[k]}/></details>)}
 {(s.services.length===0||s.tools.length===0)&&<p><small>Nothing here usually means one of: the swarm has no other enrolled peers announcing right now; a peer you expect is running a stale identity (hub key rotation — its node needs a restart, <code>sam-mesh node start</code> now self-heals via the stored refresh token); or you are looking at the server itself — a node never consumes its own services, they are for the other fleet members.</small></p>}
 <small>Captured {s.capturedAt}</small></>}
 <details><summary>Approved actions</summary><ActionForms api={api} run={act}/><p>No reset, purge, delete, cancellation, or other destructive action is exposed.</p></details></section> }

/** Snapshot services/tools as compact chips (name + one-line meta), raw JSON
 * still one click away behind the advanced details. */
function ChipSection({kind,items}:{kind:"services"|"tools";items:unknown[]}) {
 return <div style={{display:"grid",gap:4}}>
  <strong>{kind} ({items.length})</strong>
  {items.length===0&&<small style={{opacity:0.65}}>none visible</small>}
  {items.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6}}>
   {items.slice(0,40).map((x,i)=>{ const v=chipView(kind,x); return <span key={i} style={chip} title={v.meta||v.name}><code>{v.name}</code>{v.meta&&<small style={{opacity:0.7}}>{v.meta}</small>}</span> })}
   {items.length>40&&<small style={{opacity:0.65}}>+{items.length-40} more</small>}
  </div>}
  <details><summary><small>advanced — raw JSON</small></summary><Json value={items}/></details>
 </div> }

/** Model roster: grouped by serving peer when the snapshot says who serves
 * what; models this machine's own serve row announces carry a live badge. */
function ModelRoster({api,models}:{api:MeshWebApi;models:unknown[]}) {
 const [serve,setServe]=useState<{models:string[];rowState?:string|undefined;announceName:string}|null>(null)
 useEffect(()=>{ let live=true; const load=async()=>{ try{ const s=await api.inferenceServeStatus(); if(live) setServe({models:s.models,rowState:s.rowState,announceName:s.announceName}) }catch{ if(live) setServe(null) } }
  void load(); const t=setInterval(()=>void load(),5000); return ()=>{ live=false; clearInterval(t) } },[api])
 const groups=groupModels(models,serve)
 return <div style={{display:"grid",gap:4}}>
  <strong>models ({models.length})</strong>
  {models.length===0&&<small style={{opacity:0.65}}>none visible</small>}
  {groups.map(g=><div key={g.name} style={{display:"grid",gap:4}}>
   {(groups.length>1||g.name!=="mesh")&&<small style={{opacity:0.7}}>served by <code>{g.name}</code>{g.thisMachine?` (this machine${serve?.announceName?` \u00b7 ${serve.announceName}`:""})`:""}</small>}
   <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
    {g.rows.map(r=><span key={r.id} style={chip}><code>{r.id}</code>{r.badge&&<small style={{color:r.badge==="error"?"var(--danger,#e57373)":r.badge==="warming"?"var(--warning,#ffb74d)":"var(--success,#4caf50)"}}>● {r.badge}</small>}</span>)}
   </div>
  </div>)}
  <details><summary><small>advanced — raw JSON</small></summary><Json value={models}/></details>
 </div> }

function isActionResult(v:EnrollmentInfo|ActionResult):v is ActionResult { return "ok" in v }

/** Mesh node kit: bring THIS machine onto the mesh — install check, daemon
 * lifecycle, and browser-based device-flow enrollment, all from the card. */

/** First-run wizard: a guided checklist that walks a brand-new machine to
 * full fleet membership — enroll, run, join a fleet, see capability traffic.
 * Every step derives from live state (nodeStatus / fleetDiscover /
 * pairRequests / snapshot); the current step carries exactly one action. */
function WizardSection({api,onChanged}:{api:MeshWebApi;onChanged?:()=>Promise<void>}) {
 const [facts,setFacts]=useState<WizardFacts>({installed:false,enrolled:false,running:false,pairing:false})
 const [loaded,setLoaded]=useState(false)
 const [session,setSession]=useState<EnrollmentInfo|null>(null)
 const [joined,setJoined]=useState<string>()
 const [note,setNote]=useState("")
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const poll=useCallback(async()=>{
  let status:NodeStatusView|undefined
  try{ status=await api.nodeStatus() }catch{ status=undefined }
  const next:WizardFacts={installed:status?.installed??false,enrolled:status?.enrolled??false,running:status?.running??false,pairing:false}
  if(status?.running){
   const [d,p,s]=await Promise.allSettled([api.fleetDiscover(),api.pairRequests(),api.snapshot()])
   if(d.status==="fulfilled") next.fleets=d.value.fleets
   if(p.status==="fulfilled") next.pairing=p.value.pairing
   if(s.status==="fulfilled"){ next.models=s.value.models.length; next.peers=peerCount(s.value.mesh); next.ownPeer=ownPeerId(s.value.mesh) }
  }
  setFacts(next); setLoaded(true)
 },[api])
 useEffect(()=>{ let live=true; const tick=async()=>{ await poll() }; void tick()
  const t=setInterval(()=>{ if(live) void tick() },4000); return ()=>{ live=false; clearInterval(t) } },[poll])
 // Resume an enrollment started earlier (auto-begin at boot, another tab, …).
 useEffect(()=>{ let live=true; void api.activeEnrollment().then(info=>{ if(live&&info&&(info.state==="starting"||info.state==="awaiting_user")) setSession(info) }).catch(()=>undefined)
  return ()=>{ live=false } },[api])
 // Poll an in-flight enrollment until it resolves.
 useEffect(()=>{ if(!session||(session.state!=="starting"&&session.state!=="awaiting_user")) return
  const t=setInterval(async()=>{ try{ const info=await api.enrollmentStatus(session.sessionId)
   if(info){ setSession(info); if(info.state==="complete"){ setNote("Enrolled \u2014 this machine is on the hub."); await poll(); await onChanged?.() } } }catch{ /* transient */ } },1500)
  return ()=>clearInterval(t) },[session,api,poll,onChanged])
 const begin=async()=>{ setNote(""); try{ const r=await api.beginEnrollment(approve()); if(isActionResult(r)) setNote(r.ok?r.message:r.error); else setSession(r) }catch(e){ setNote(e instanceof Error?e.message:String(e)) } }
 const start=async()=>{ setNote(""); const r=await api.startNode(approve())
  setNote(r.ok?r.message:`${r.error} \u2014 fix: run \`sam-mesh node start\` in a terminal to see the underlying error.`); await poll() }
 const steps=wizardSteps({...facts,joinedFleet:joined})
 const allDone=steps.every(s=>s.done)
 const list=<ol style={{margin:0,paddingLeft:0,listStyle:"none",display:"grid",gap:8}}>
  {steps.map(s=><li key={s.id}>
   <div>{s.done?<span style={{color:"var(--success,#4caf50)"}}>✓</span>:s.current?<span>→</span>:<span style={{opacity:0.5}}>○</span>}{" "}{s.label}{s.done&&s.detail?` \u2014 ${s.detail}`:""}</div>
   {s.current&&<div style={{margin:"4px 0 0 20px",display:"grid",gap:6}}>
    {s.error&&<p role="alert" style={{margin:0}}>{s.error}{s.fix?` \u2014 fix: ${s.fix}`:""}</p>}
    {!s.error&&s.detail&&<small style={{opacity:0.75}}>{s.detail}</small>}
    {s.id==="enroll"&&facts.installed&&!session&&<div><button style={button} onClick={()=>void begin()}>Begin enrollment (approved)</button></div>}
    {s.id==="enroll"&&session&&(session.state==="starting"||session.state==="awaiting_user")&&<div style={{...panel,border:"1px solid var(--accent,#6a9fff)"}}>
     {session.mode==="bootstrap"?<p style={{margin:0}}>Enrolling with the stored pre-shared token — no browser step needed…</p>
      :session.state==="starting"?<p style={{margin:0}}>Contacting the control plane…</p>
      :<>
       <p style={{margin:0}}><b>Authorize this machine</b> — open the link and enter the code:</p>
       <p style={{margin:0,fontSize:15,wordBreak:"break-all"}}><a href={session.verificationUrl!} target="_blank" rel="noreferrer">{session.verificationUrl}</a>{" "}<CopyButton text={session.verificationUrl!}/></p>
       <p style={{margin:0,fontSize:22,letterSpacing:3}}><b>{session.userCode}</b>{" "}<CopyButton text={session.userCode!}/></p>
       <p role="status" style={{margin:0}}><small>Waiting for approval…</small></p>
       <EnrollCountdown/>
       <div><button style={button} onClick={()=>void api.cancelEnrollment(session.sessionId).then(()=>{ setSession(null); setNote("Enrollment cancelled") }).catch(()=>undefined)}>Cancel</button></div>
      </>}
    </div>}
    {s.id==="enroll"&&session&&(session.state==="failed"||session.state==="cancelled")&&<p role="alert" style={{margin:0}}>Enrollment {session.state}{session.error?`: ${session.error}`:""} — fix: begin enrollment again; if it keeps failing, check the control plane URL in Settings \u2192 Plugins \u2192 Agent Mesh.{" "}<button style={button} onClick={()=>void begin()}>Try again</button></p>}
    {s.id==="run"&&<div><button style={button} onClick={()=>void start()}>Start node (approved)</button></div>}
    {s.id==="fleet"&&<JoinFleetSection api={api} onJoined={name=>{ setJoined(name); void onChanged?.() }}/>}
    {s.id==="ready"&&<div style={{display:"grid",gap:6}}><small style={{opacity:0.75}}>The node is up but the card cannot see fleet activity yet — fleets appear once an operator announces services, or share your own models in Settings \u2192 Plugins \u2192 Agent Mesh.</small><div><button style={button} onClick={()=>void poll()}>Re-check</button></div></div>}
   </div>}
  </li>)}
 </ol>
 if(allDone) return <details style={panel}><summary style={{cursor:"pointer"}}><span style={{color:"var(--success,#4caf50)"}}>✓</span> On the mesh — {facts.peers??0} peers, {facts.models??0} models</summary><div style={{marginTop:8}}>{list}</div></details>
 return <div style={panel}>
  <strong>Get on the mesh</strong>
  {!loaded?<small style={{opacity:0.7}}>Checking this machine…</small>:list}
  {note&&<p role="status" style={{margin:0}}><small>{note}</small></p>}
 </div>
}


/** Fleet pairing approvals: join requests from machines that discovered this
 * fleet in the public swarm. The operator's human gate, in the browser. */

type PairView = {sessionId:string;fleet:string;state:string;error?:string;notes?:string[]}

/** Join a fleet FROM this machine, entirely in the browser: discover fleets
 * in the swarm, request to pair, watch the operator's approval land. The
 * host owns keys, polling, sealed-invite opening, and provisioning. */
function JoinFleetSection({api,onJoined}:{api:MeshWebApi;onJoined?:(fleet:string)=>void}) {
 const [result,setResult]=useState<{fleets:{name:string;providers:number;peerIds:string[];description?:string}[];node:{running:boolean;enrolled:boolean;enrolledHub:string|null};needsReenroll:boolean;membership:{state:"valid"|"stale"|"unpaired";detail?:string}}>()
 const [session,setSession]=useState<PairView>()
 const [note,setNote]=useState("")
 const discover=async()=>{ setNote(""); try{ setResult(await api.fleetDiscover()) }catch(e){ setNote(e instanceof Error?e.message:String(e)) } }
 useEffect(()=>{ if(!session||session.state!=="waiting") return
  const t=setInterval(async()=>{ const s=await api.fleetPairStatus(session.sessionId); setSession({...session,...s}); if(s.state==="complete"&&s.fleet) onJoined?.(s.fleet) },2000)
  return ()=>clearInterval(t) },[session?.sessionId,session?.state])
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const [code,setCode]=useState("")
 const request=async(serviceName:string,inviteCode?:string)=>{ const r=await api.requestFleetPair({serviceName,...(inviteCode?{inviteCode}:{})},approve())
  if(r.ok&&r.sessionId) setSession({sessionId:r.sessionId,fleet:serviceName,state:"waiting",...(inviteCode?{error:"joining with invite code…"}:{})}); else setNote(r.error??"request failed") }
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Join a fleet</strong>{" "}<button style={button} onClick={()=>void discover()}>Discover fleets</button>
  {result?.needsReenroll&&<p role="alert" style={{margin:"4px 0",padding:"6px 8px",border:"1px solid #c33",borderRadius:6}}><strong>Mesh identity needs re-approval.</strong> The hub rotated its keys and the stored refresh token cannot heal it — enroll again below (one browser approval).</p>}
  {result&&<p style={{margin:"4px 0",opacity:0.85}}><small>
   {result.membership.state==="valid"&&<>✓ fleet member — capability verified</>}
   {result.membership.state==="stale"&&<>✗ membership stale — {result.membership.detail}</>}
   {result.membership.state==="unpaired"&&<>○ not fleet-paired — join below for gated tools/models</>}
  </small></p>}
  {note&&<p role="alert" style={{margin:"4px 0"}}>{note}</p>}
  {session&&session.state==="waiting"&&<p style={{margin:"6px 0 0"}}>Waiting for an operator to approve your request to <code>{session.fleet}</code>… (they approve from their card or sam-mesh fleet approvals)</p>}
  {session&&session.state==="complete"&&<div style={{margin:"6px 0 0"}}><p style={{margin:0}}>✓ You hold the <code>{session.fleet}</code> capability.</p><ul style={{margin:"4px 0 0",paddingLeft:18}}>{session.notes?.map((n,i)=><li key={i}><small>{n}</small></li>)}</ul></div>}
  {session&&session.state==="failed"&&<p role="alert" style={{margin:"6px 0 0"}}>Pairing failed: {session.error}</p>}
  {result&&!result.node.running&&<p role="alert" style={{margin:"6px 0 0"}}>Your node is not running — enroll and start it in the <strong>Mesh node</strong> section above, then discover again.</p>}
  {result&&result.node.running&&!result.node.enrolled&&<p role="alert" style={{margin:"6px 0 0"}}>Your node is running but not enrolled — use <strong>Mesh node → Enroll this machine</strong> above, then discover again.</p>}
  {result&&result.node.running&&result.node.enrolled&&result.fleets.length===0&&<p style={{margin:"6px 0 0",opacity:0.7}}>No fleets visible on <code>{result.node.enrolledHub ?? "your hub"}</code>. If you expected one, check it announces on THIS hub — the card's doctor shows where you are enrolled{result.node.enrolledHub?.includes("hub.sam-mesh.dev")?"":" (you are NOT on the public hub — a stale private-hub identity sees a different swarm)"}.</p>}
  {result&&result.node.running&&result.node.enrolled&&result.fleets.length>0&&<div style={{margin:"6px 0 0"}}>
   <p style={{margin:"0 0 4px"}}><input style={input} placeholder="invite code (optional — skips approval)" value={code} onChange={e=>setCode(e.target.value.trim())} /></p>
   <ul style={{margin:0,paddingLeft:18,display:"grid",gap:4}}>
    {result.fleets.map(f=><li key={f.name}><code>{f.name}</code>{" "}<small>{f.providers} provider{f.providers===1?"":"s"}{f.description?` — ${f.description}`:""}</small>{" "}
     <button style={button} disabled={session?.state==="waiting"} onClick={()=>void request(f.name,code||undefined)}>{code?"Join with code":"Request to join"}</button></li>)}
   </ul>
   {code&&<small>Code entered — joining is instant, no operator approval needed.</small>}
  </div>}
 </div>
}


/** iMessage setup for Linux members: hardware key state + the two-path wizard
 * (extract from your own Mac, or request one from the operator through the mesh). */
function IMessageSetupSection({api}:{api:MeshWebApi}) {
 const [needsKey,setNeedsKey]=useState<boolean>(false)
 const [mode,setMode]=useState<'request'|'own'>('request')
 const [requestId,setRequestId]=useState('')
 const [note,setNote]=useState('')
 const [busy,setBusy]=useState(false)
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const request=async()=>{
  if(busy) return; setBusy(true); setNote('')
  try{
   const keys=(await import('node:crypto')).generateKeyPairSync('x25519')
   const requestId=(await import('node:crypto')).randomBytes(16).toString('hex')
   const publicKey=keys.publicKey.export({format:'jwk'}) as {x?:string}
   const label=`dsh@${(await import('node:os')).hostname()}`
   const res=await (api.core as any).callRemoteTool({peer_id:'',tool_name:'mcp://dsh-task-service/imessage_key_request',arguments:{requestId,publicKey:publicKey.x!,label}})
   if(res.ok){setRequestId(requestId);setNote(`Requested — the operator will extract a key on their Mac and deliver it sealed (single-use).`)}
   else setNote(res.error??'request failed')
  }catch(e){setNote(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
 }
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10,display:"grid",gap:6}}>
  <strong>iMessage setup (Linux)</strong>
  <small style={{opacity:0.75}}>The bridge needs a hardware key — extracted from a Mac once. Two ways to get it:</small>
  <div style={{display:"flex",gap:8}}>
   <button style={{...button,fontWeight:mode==='request'?700:400}} onClick={()=>setMode('request')}>Request from operator</button>
   <button style={{...button,fontWeight:mode==='own'?700:400}} onClick={()=>setMode('own')}>Extract from my Mac</button>
  </div>
  {mode==='request'&&<div style={{display:"grid",gap:6}}>
   {requestId?<p style={{margin:0}}>✓ Request sent (id {requestId.slice(0,10)}…) — the operator's fleet admin will extract and deliver the key. You'll see it in the channel.</p>
   :<p style={{margin:0}}>Ask the operator to extract a hardware key on their Mac and deliver it to you through the mesh (sealed to this request, single-use).</p>}
   <div><button style={button} disabled={busy||!!requestId} onClick={()=>void request()}>{requestId?'Requested':'Request a key'}</button></div>
  </div>}
  {mode==='own'&&<div style={{display:"grid",gap:6}}>
   <p style={{margin:0}}>On your Mac, run the ExtractKey tool from the corten-matrix repo (tools/), then paste the result below.</p>
   <input style={input} placeholder="paste the hardware key blob…"/>
   <div><button style={button}>Save key</button></div>
  </div>}
  {note&&<p role="status" style={{margin:0}}>{note}</p>}
 </div>
}

function FleetAdminSection({api}:{api:MeshWebApi}) {
 const [state,setState]=useState<{ok:boolean;pending?:{requestId:string;label:string;requestedAt?:string}[];error?:string}>()
 const [note,setNote]=useState("")
 useEffect(()=>{ let live=true; const poll=async()=>{ try{ const r=await api.fleetAdminRequests({}); if(live) setState(r) }catch(e){ if(live) setState({ok:false,error:e instanceof Error?e.message:String(e)}) } }
  void poll(); const t=setInterval(()=>void poll(),5000); return ()=>{ live=false; clearInterval(t) } },[api])
 if(!state) return null
 // Not paired yet (or no fleet visible): the section explains instead of rendering a wall.
 if(!state.ok) return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Fleet administration</strong><p style={{margin:"4px 0 0",opacity:0.7}}>{state.error}</p>
 </div>
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const act=async(f:()=>Promise<ActionResult>)=>{ const r=await f(); setNote(r.ok?r.message:r.error) }
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10}}>
  <strong>Fleet administration</strong>{" "}<small>{(state.pending??[]).length===0?"no pending requests on the fleet server":`${state.pending!.length} pending on the fleet server`}</small>
  {note&&<p role="status" style={{margin:"4px 0"}}>{note}</p>}
  <p style={{margin:"4px 0 0"}}>
   <button style={button} onClick={()=>void (async()=>{ const r=await api.fleetInviteCreate({},approve()); setNote(r.ok?`Invite code (single-use, 15 min): ${r.code}`:`${r.error}`) })()}>Generate invite code</button>
  </p>
  {(state.pending??[]).length>0&&<ul style={{margin:"6px 0 0",paddingLeft:18,display:"grid",gap:6}}>
   {state.pending!.map(r=><li key={r.requestId}>
    <code>{r.label}</code>{" "}<small>id {r.requestId.slice(0,10)}…</small>{" "}
    <button style={button} onClick={()=>void act(()=>api.fleetAdminApprove({requestId:r.requestId},approve()))}>Approve</button>{" "}
    <button style={button} onClick={()=>void act(()=>api.fleetAdminReject({requestId:r.requestId},approve()))}>Reject</button>
   </li>)}
  </ul>}
  <PeerExecConsole api={api}/>
  <small>Runs the fleet server's operator queue through the capability-gated mesh tools — approve only machines you expected.</small>
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
 const [status,setStatus]=useState<NodeStatusView>()
 const [note,setNote]=useState("")
 const refresh=useCallback(async()=>{ setStatus(await api.nodeStatus()) },[api])
 useEffect(()=>{ void refresh() },[refresh])
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const act=async(f:()=>Promise<ActionResult>)=>{ const r=await f(); setNote(r.ok?r.message:r.error); await refresh(); await onChanged() }
 if(!status) return null
 return <details open={!status.enrolled}><summary>Mesh node ({status.running?"running":status.enrolled?"enrolled, stopped":"not enrolled"})</summary>
  <div style={{display:"grid",gap:8,marginTop:8}}>
   <PairingSection api={api}/>
   <FleetAdminSection api={api}/>
   <p style={{margin:0,opacity:0.75}}>{status.running?(status.managedByDsh?"Started by dsh — stops automatically when dsh stops.":"Running independently of dsh — use Stop node to shut it down."):status.enrolled?"Stopped — Start node brings it up (dsh-managed).":"Not enrolled — the checklist above walks you through enrollment."}</p>
   <dl style={{margin:0}}><dt>Binary</dt><dd>{status.installed?status.binaryPath:"sam-node not found on PATH"}</dd><dt>Data dir</dt><dd>{status.dataDir}</dd>{status.pid!==null&&<><dt>PID</dt><dd>{status.pid}</dd></>}</dl>
   <div>
    {!status.running&&status.enrolled&&<button style={button} onClick={()=>void act(()=>api.startNode(approve()))}>Start node (approved)</button>}{" "}
    {status.running&&<button style={button} onClick={()=>void act(()=>api.stopNode(approve()))}>Stop node (approved)</button>}
   </div>
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
 {api&&<SteerSection api={api}/>}
 <TextField label="Enrollment credential ref" hint="Managed-store reference for pre-shared (unattended) enrollment; empty = browser flow (live)" value={v.nodeEnrollmentCredentialRef??""} placeholder="SAM_MESH_BOOTSTRAP" onChange={x=>set("nodeEnrollmentCredentialRef",x)}/>
 <TextField label="Node TCP URL" hint="Local node fallback endpoint (restart)" value={v.tcpUrl??""} placeholder="http://127.0.0.1:8080" onChange={x=>set("tcpUrl",x)}/>
 <TextField label="Node socket" hint="Unix socket path, or 'false' for TCP only (restart)" value={String(v.socketPath??"")} placeholder="~/.config/sam-mesh/sam.sock" onChange={x=>set("socketPath",x==="false"?false:x)}/>
 <Toggle label="Prefer socket" hint="Use the unix socket before TCP (restart)" value={v.preferSocket??true} onChange={x=>set("preferSocket",x)}/>
 <div style={fieldRow}><div><div>Request timeout (ms)</div><small style={{opacity:0.65}}>Mesh call timeout (restart)</small></div>
  <input style={{...textInput,width:110}} type="number" value={v.timeoutMs??30000} onChange={e=>set("timeoutMs",Number(e.target.value)||30000)}/></div>
 </section> }



/** Operator diagnostics console (D3): run bounded commands on fleet members
 * through the mesh — tonight's /tmp/pexec.mjs as a first-class surface. */
function PeerExecConsole({api}:{api:MeshWebApi}) {
 const [members,setMembers]=useState<{id:string;name:string}[]>([])
 const [memberId,setMemberId]=useState("")
 const [command,setCommand]=useState("")
 const [out,setOut]=useState<{ok:boolean;member?:string;exit?:number|null;stdout?:string;stderr?:string;timedOut?:boolean;error?:string}>()
 const [busy,setBusy]=useState(false)
 const [open,setOpen]=useState(false)
 useEffect(()=>{ if(!open) return; let live=true
  void api.fleetAdminMembers({}).then(r=>{ if(live&&r.ok&&r.members){ setMembers(r.members.map(m=>({id:m.id,name:m.name}))); if(r.members.length>0) setMemberId(v=>v||r.members![0]!.id) } }).catch(()=>undefined)
  return ()=>{ live=false } },[open,api])
 const approve=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const run=async()=>{ if(busy||!command.trim()) return; setBusy(true); setOut(undefined)
  try{ setOut(await api.peerExec({command:command.trim(),...(memberId?{memberId}:{})},approve())) }catch(e){ setOut({ok:false,error:e instanceof Error?e.message:String(e)}) }finally{ setBusy(false) } }
 return <details style={{marginTop:6}} open={open} onToggle={e=>setOpen((e.target as HTMLDetailsElement).open)}>
  <summary style={{cursor:"pointer"}}><strong>Diagnostics console</strong> <small style={{opacity:0.7}}>operator: bounded commands on members, over the mesh</small></summary>
  <div style={{display:"grid",gap:6,marginTop:6}}>
   <div style={{display:"flex",gap:6,alignItems:"center"}}>
    <select style={{padding:"4px 6px",borderRadius:6}} value={memberId} onChange={e=>setMemberId(e.target.value)}>
     {members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
     {members.length===0&&<option value="">no members</option>}
    </select>
    <input style={{...textInput,flex:1}} placeholder="command (bounded, 30s)…" value={command} onChange={e=>setCommand(e.target.value)}
     onKeyDown={e=>{ if(e.key==="Enter") void run() }}/>
    <button style={button} disabled={busy||!command.trim()||members.length===0} onClick={()=>void run()}>{busy?"…":"Run"}</button>
   </div>
   {out&&<pre style={{whiteSpace:"pre-wrap",maxHeight:220,overflow:"auto",fontSize:12,margin:0,padding:8,border:"1px solid var(--border,#333)",borderRadius:6}}>
    {out.ok?`$ ${out.member??""} — exit ${out.exit??"?"}${out.timedOut?" (timed out)":""}\n${out.stdout??""}${out.stderr?`\n[stderr] ${out.stderr}`:""}`:`error: ${out.error}`}
   </pre>}
  </div>
 </details>
}

/** Live model steering: a small window into the served model's defaults —
 * operator-only writes (inference_steer), member-visible status. Every change
 * takes effect on the NEXT request through the gate. */
function SteerSection({api}:{api:MeshWebApi}) {
 const [status,setStatus]=useState<{ok:boolean;rows?:Record<string,{systemPrompt?:string;temperature?:number;topP?:number;maxTokens?:number}>;error?:string}>()
 const [row,setRow]=useState("")
 const [systemPrompt,setSystemPrompt]=useState("")
 const [temperature,setTemperature]=useState("")
 const [note,setNote]=useState("")
 const [busy,setBusy]=useState(false)
 useEffect(()=>{ let live=true; const poll=async()=>{ try{ const r=await api.inferenceSteerStatus({}); if(live) setStatus(r) }catch(e){ if(live) setStatus({ok:false,error:e instanceof Error?e.message:String(e)}) } }
  void poll(); const t=setInterval(()=>void poll(),10_000); return ()=>{ live=false; clearInterval(t) } },[api])
 if(!status||!status.ok) return null
 const rows=Object.keys(status.rows??{})
 if(rows.length===0) return null
 const current=status.rows?.[row||rows[0]!]??{}
 const apply=()=>({approved:true,approvedBy:"DeepSeek Harness web user"})
 const act=async(f:()=>Promise<ActionResult>)=>{ if(busy) return; setBusy(true); setNote("")
  try{ const r=await f(); setNote(r.ok?r.message??"applied":r.error??"failed") }catch(e){ setNote(e instanceof Error?e.message:String(e)) }finally{ setBusy(false) } }
 return <div style={{border:"1px solid var(--border,#444)",borderRadius:8,padding:10,display:"grid",gap:6}}>
  <strong>Model steering</strong> <small style={{opacity:0.7}}>live defaults on the gate — next request picks them up (operator)</small>
  <div style={{display:"flex",gap:8,alignItems:"center"}}>
   <label style={{fontSize:12}}>row</label>
   <select style={{padding:"4px 6px",borderRadius:6}} value={row||rows[0]} onChange={e=>setRow(e.target.value)}>{rows.map(r=><option key={r} value={r}>{r}</option>)}</select>
   <label style={{fontSize:12}}>temperature</label>
   <input style={{...textInput,width:70}} placeholder={String(current.temperature??"backend")} value={temperature} onChange={e=>setTemperature(e.target.value)}/>
  </div>
  <textarea style={{...textInput,minHeight:56,fontFamily:"inherit"}} placeholder={`system prompt (current: ${current.systemPrompt?current.systemPrompt.slice(0,60)+"…":"none"})`} value={systemPrompt} onChange={e=>setSystemPrompt(e.target.value)}/>
  <div style={{display:"flex",gap:8}}>
   <button style={button} disabled={busy} onClick={()=>void act(()=>api.inferenceSteerApply({row:(row||rows[0]) as string,...(systemPrompt?{systemPrompt}:{}) ,...(temperature!==""?{temperature:Number(temperature)}:{})},apply()))}>Apply</button>
   <button style={button} disabled={busy} onClick={()=>void act(()=>api.inferenceSteerApply({row:(row||rows[0]) as string,clear:true},apply()))}>Clear</button>
   {note&&<small role="status" style={{alignSelf:"center"}}>{note}</small>}
  </div>
 </div>
}

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
