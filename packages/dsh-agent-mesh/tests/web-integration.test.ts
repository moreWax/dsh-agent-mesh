import { describe,expect,it,vi } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol"
import { AgentMeshWebHost } from "../src/web/host.js"
import remoteContribution from "../src/remote.js"
import { apply as applyClient,createMeshWebApi,inject } from "../src/client/index.js"
const mesh:any={core:{socketPath:"/tmp/sam.sock",baseUrl:"http://x",getMeshInfo:async()=>({peer_id:"p",router_peer_id:"r",connected_peers:2,dht_size:4}),findRemoteTools:async()=>[],listModels:async()=>({data:[]}),callTool:async()=>[]},operator:{connectivity:async()=>({connected:true,peers:2}),tokenStatus:async()=>({present:true}),services:async()=>[],recentLogs:async()=>[],planSkillInstall:()=>({command:{executable:"false",args:[]}}),registerService:async(q:any)=>q}}
describe("agent mesh web integration",()=>{it("hosts the strict remote surface",()=>{const ctx=new Context();const h=new AgentMeshWebHost(ctx,mesh);expect(remoteMethods(h).map(x=>x.method)).toEqual(["snapshot","check","nodeStatus","nodeBinaryOptions","startNode","stopNode","beginEnrollment","enrollmentStatus","activeEnrollment","cancelEnrollment","meshDoctor","fleetDiscover","requestFleetPair","fleetPairStatus","pairRequests","approvePairRequest","rejectPairRequest","fleetAdminRequests","fleetAdminApprove","fleetAdminReject","fleetAdminMembers","fleetAdminRevoke","installSkill","registerService","deviceFlowInstructions","inferenceServeStatus","runtimeStatus","runtimePull","runtimePullStatus","inferenceServeConfigure"/* scaffold-anchor: surface */]);expect(remoteContribution.descriptors).toHaveLength(30/* scaffold-anchor: count */)})
it("aggregates dashboard facts and keeps probe failures visible",async()=>{mesh.core.findRemoteTools=async()=>{throw new Error("tools offline")};const s=await new AgentMeshWebHost(new Context(),mesh).snapshot();expect(s.transport).toEqual({kind:"unix",endpoint:"/tmp/sam.sock"});expect(s.failures).toContainEqual({probe:"tools",message:"tools offline"});expect((s.mesh as any).router_peer_id).toBe("r")})
it("refuses mutations without explicit approval",async()=>{const h=new AgentMeshWebHost(new Context(),mesh);expect(await h.startNode({approved:false})).toEqual({ok:false,error:expect.stringContaining("approval")});expect(await h.installSkill({source:"x"},{approved:true})).toEqual({ok:false,error:expect.stringContaining("approver")});expect(await h.registerService({name:"x",protocol:"http",endpoint:"http://x"},{approved:false})).toEqual({ok:false,error:expect.stringContaining("approval")})})
it("unwraps and mounts into settings.section",async()=>{const snapshot={transport:{kind:"tcp",endpoint:"x"},services:[],tools:[],models:[],tasks:[],logs:[],failures:[],capturedAt:"now"};const r:any={agentMeshWeb:{snapshot:vi.fn(async()=>({ok:true,value:snapshot})),check:vi.fn(),startNode:vi.fn(),installSkill:vi.fn(),registerService:vi.fn(),deviceFlowInstructions:vi.fn()}};expect(await createMeshWebApi({remote:r} as any).snapshot()).toBe(snapshot);const mount=vi.fn(async()=>async()=>{}),register=vi.fn(),slotInject=vi.fn((_k:string,f:()=>void)=>f())
 const uiCtx:any={slots:{inject:slotInject,register},settingsScope:{bind:vi.fn(()=>({getSnapshot:()=>({status:"unavailable"}),subscribe:()=>()=>{},set:vi.fn(),unset:vi.fn()}))},remote:r}
 const pluginMock=vi.fn((spec:any)=>{ spec.apply(uiCtx); return { dispose:vi.fn(async()=>{}) } })
 await applyClient({remote:{$mount:mount},slots:{inject:slotInject,register},settingsScope:uiCtx.settingsScope,plugin:pluginMock} as any)
 // the OUTER plugin must not wait on the namespace it provides itself (deadlock)
 expect(inject).toEqual(["slots","remote","settingsScope"])
 expect(mount).toHaveBeenCalledWith(remoteContribution)
 expect(pluginMock).toHaveBeenCalledWith(expect.objectContaining({name:"agent-mesh-ui",inject:expect.arrayContaining(["remote.agentMeshWeb"])}))
 expect(slotInject).toHaveBeenCalledWith("settings.section",expect.any(Function))
 expect(register).toHaveBeenCalledWith(expect.objectContaining({id:"agent-mesh",name:"settings.section"}),expect.any(Function))})})

it("fleet admin: no capability → pair-first guidance, never calls the mesh",async()=>{
  const m2:any={core:{...mesh.core,discoverRemoteServices:async()=>[{srv_name:"dsh-task-service",peer_id:"peer-escha"}]},operator:mesh.operator,resolveCallCapability:undefined}
  const h=new AgentMeshWebHost(new Context(),m2)
  const r=await h.fleetAdminRequests({})
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/pair this machine first/)
})
it("fleet admin: paired machine drives the operator tools with the capability",async()=>{
  const calls:any[]=[]
  const m2:any={core:{...mesh.core,
    discoverRemoteServices:async()=>[{srv_name:"dsh-task-service",peer_id:"peer-escha"}],
    callRemoteTool:async(req:any)=>{calls.push(req);return req.tool_name.endsWith("fleet_pair_list")?{pending:[{requestId:"abc123def4567890",label:"dsh@mac"}]}:{approved:true,requestId:req.arguments.requestId,label:"dsh@mac"}}},
    operator:mesh.operator,resolveCallCapability:async()=>"fleet-cap"}
  const h=new AgentMeshWebHost(new Context(),m2)
  const list=await h.fleetAdminRequests({})
  expect(list).toMatchObject({ok:true,pending:[{requestId:"abc123def4567890",label:"dsh@mac"}]})
  expect(calls[0]).toMatchObject({peer_id:"peer-escha",tool_name:"mcp://dsh-task-service/fleet_pair_list",arguments:{_capability:"fleet-cap"}})
  const approval=await h.fleetAdminApprove({requestId:"abc123def4567890"},{approved:true,approvedBy:"tester"})
  expect(approval.ok).toBe(true)
  expect(calls[1].arguments).toMatchObject({_capability:"fleet-cap",requestId:"abc123def4567890",approvedBy:"tester"})
  const rejected=await h.fleetAdminApprove({requestId:"x"},{approved:false,approvedBy:""})
  expect(rejected.ok).toBe(false)  // unapproved mutations never reach the mesh
  expect(calls).toHaveLength(2)
})
