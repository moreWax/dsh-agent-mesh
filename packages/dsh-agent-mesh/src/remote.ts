import { z } from "zod"
import type { RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol"
import type { MeshDashboardSnapshot, ApprovedAction, ActionResult } from "./web/host.js"
import type { EnrollmentInfo } from "@morewax/sam-mesh/node"
import type { NodeStatusView } from "./web/host.js"
import type { ServiceRegistrationRequest, SkillInstallRequest } from "./operator/index.js"
import type { DoctorCheck } from "@morewax/sam-mesh/plan"
declare module "@deepseek-ai/dsh-typert-protocol" { interface TypertRemoteNamespaceMap { agentMeshWeb: {
  snapshot(): Promise<RemoteResult<MeshDashboardSnapshot>>; check(): Promise<RemoteResult<MeshDashboardSnapshot>>
  installSkill(request: SkillInstallRequest, approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  registerService(request: ServiceRegistrationRequest, approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  deviceFlowInstructions(): Promise<RemoteResult<string[]>>
  nodeStatus(): Promise<RemoteResult<NodeStatusView>>
  startNode(approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  stopNode(approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  beginEnrollment(approval: ApprovedAction, options?: { controlPlane?: string }): Promise<RemoteResult<EnrollmentInfo | ActionResult>>
  enrollmentStatus(sessionId: string): Promise<RemoteResult<EnrollmentInfo | null>>
  activeEnrollment(): Promise<RemoteResult<EnrollmentInfo | null>>
  cancelEnrollment(sessionId: string): Promise<RemoteResult<ActionResult>>
  meshDoctor(): Promise<RemoteResult<{ checks: DoctorCheck[] }>>
  pairRequests(): Promise<RemoteResult<{ pairing: boolean; pending: { requestId: string; label: string; requestedAt: number }[] }>>
  approvePairRequest(requestId: string, approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
  rejectPairRequest(requestId: string, approval: ApprovedAction): Promise<RemoteResult<ActionResult>>
} } }
const any = z.unknown(), approval=z.object({approved:z.boolean(),approvedBy:z.string().optional()})
const skill=z.object({source:z.string(),name:z.string().optional(),version:z.string().optional(),target:z.string().optional(),force:z.boolean().optional()})
const service=z.object({name:z.string(),protocol:z.string(),endpoint:z.string(),metadata:z.record(z.string(),z.unknown()).optional(),ttlSeconds:z.number().optional()})
const nodeStatusSchema=z.object({installed:z.boolean(),binaryPath:z.string().nullable(),enrolled:z.boolean(),running:z.boolean(),pid:z.number().nullable(),socketPath:z.string(),dataDir:z.string(),managedByDsh:z.boolean()})
const enrollmentInfo=z.object({sessionId:z.string(),state:z.union([z.literal("starting"),z.literal("awaiting_user"),z.literal("complete"),z.literal("failed"),z.literal("cancelled")]),controlPlane:z.string(),verificationUrl:z.string().nullable(),userCode:z.string().nullable(),error:z.string().nullable()})
const doctorCheck=z.object({name:z.string(),ok:z.boolean(),detail:z.string().optional(),fix:z.string().optional()})
const actionResult=z.union([z.object({ok:z.literal(true),message:z.string()}),z.object({ok:z.literal(false),error:z.string()})])
const enrollOptions=z.object({controlPlane:z.string().optional()}).optional()
const parameter=(name:string,schema:z.ZodType)=>({name,wire:name,source:"json" as const,codec:{mode:"strict" as const,typeSymbol:`@morewax/dsh-agent-mesh#${name}`,schema}})
const result=(name:string,schema:z.ZodType)=>({mode:"strict" as const,typeSymbol:`@morewax/dsh-agent-mesh#${name}`,schema})
const descriptor=(method:string,parameters:ReturnType<typeof parameter>[],schema:z.ZodType=any)=>({id:`@morewax/dsh-agent-mesh#agentMeshWeb/${method}`,service:"agentMeshWeb",namespace:"agentMeshWeb",method,invocation:{kind:"direct" as const},parameters,result:result(`${method}Result`,schema)})
export const TYPERT_REMOTE: TypertRemoteContribution={package:"@morewax/dsh-agent-mesh",descriptors:[descriptor("snapshot",[]),descriptor("check",[]),descriptor("installSkill",[parameter("request",skill),parameter("approval",approval)]),descriptor("registerService",[parameter("request",service),parameter("approval",approval)]),descriptor("deviceFlowInstructions",[],z.array(z.string())),descriptor("nodeStatus",[],nodeStatusSchema),descriptor("startNode",[parameter("approval",approval)],actionResult),descriptor("stopNode",[parameter("approval",approval)],actionResult),descriptor("beginEnrollment",[parameter("approval",approval),parameter("options",enrollOptions)],z.union([enrollmentInfo,actionResult])),descriptor("enrollmentStatus",[parameter("sessionId",z.string())],enrollmentInfo.nullable()),descriptor("activeEnrollment",[],enrollmentInfo.nullable()),descriptor("cancelEnrollment",[parameter("sessionId",z.string())],actionResult),descriptor("meshDoctor",[],z.object({checks:z.array(doctorCheck)})),descriptor("pairRequests",[],z.object({pairing:z.boolean(),pending:z.array(z.unknown())})),descriptor("approvePairRequest",[parameter("requestId",z.string()),parameter("approval",approval)],actionResult),descriptor("rejectPairRequest",[parameter("requestId",z.string()),parameter("approval",approval)],actionResult)]}
export default TYPERT_REMOTE
