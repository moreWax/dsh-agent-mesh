import { z } from "zod"
import type { RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol"
import type { MeshDashboardSnapshot, ApprovedAction, ActionResult } from "./web/host.js"
import type { ServiceRegistrationRequest, SkillInstallRequest } from "./operator/index.js"
declare module "@deepseek-ai/dsh-typert-protocol" { interface TypertRemoteNamespaceMap { agentMeshWeb: {
  snapshot(): Promise<RemoteResult<MeshDashboardSnapshot>>; check(): Promise<RemoteResult<MeshDashboardSnapshot>>
  startNode(approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  installSkill(request: SkillInstallRequest, approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  registerService(request: ServiceRegistrationRequest, approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  deviceFlowInstructions(): Promise<RemoteResult<string[]>>
} } }
const any = z.unknown(), approval=z.object({approved:z.boolean(),approvedBy:z.string().optional()})
const skill=z.object({source:z.string(),name:z.string().optional(),version:z.string().optional(),target:z.string().optional(),force:z.boolean().optional()})
const service=z.object({name:z.string(),protocol:z.string(),endpoint:z.string(),metadata:z.record(z.string(),z.unknown()).optional(),ttlSeconds:z.number().optional()})
const parameter=(name:string,schema:z.ZodType)=>({name,wire:name,source:"json" as const,codec:{mode:"strict" as const,typeSymbol:`@morewax/dsh-agent-mesh#${name}`,schema}})
const result=(name:string,schema:z.ZodType)=>({mode:"strict" as const,typeSymbol:`@morewax/dsh-agent-mesh#${name}`,schema})
const descriptor=(method:string,parameters:ReturnType<typeof parameter>[],schema:z.ZodType=any)=>({id:`@morewax/dsh-agent-mesh#agentMeshWeb/${method}`,service:"agentMeshWeb",namespace:"agentMeshWeb",method,invocation:{kind:"direct" as const},parameters,result:result(`${method}Result`,schema)})
export const TYPERT_REMOTE: TypertRemoteContribution={package:"@morewax/dsh-agent-mesh",descriptors:[descriptor("snapshot",[]),descriptor("check",[]),descriptor("startNode",[parameter("approval",approval)]),descriptor("installSkill",[parameter("request",skill),parameter("approval",approval)]),descriptor("registerService",[parameter("request",service),parameter("approval",approval)]),descriptor("deviceFlowInstructions",[],z.array(z.string()))]}
export default TYPERT_REMOTE
