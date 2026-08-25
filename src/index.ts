/** dsh-agent-mesh composition root: one socket-first SAM capability service. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SamClient } from './core/index.js'
import { SamToolClient } from './tools/index.js'
import { SamInferenceClient } from './inference/index.js'
import { SamOperator } from './operator/index.js'
export const name='agent-mesh';export const provide=['agentMesh']
export interface Config {socketPath?:string;tcpUrl?:string;preferSocket?:boolean;apiToken?:string}
export const Config:z<Config>=z.object({socketPath:z.string().default('~/.config/sam-mesh/sam.sock'),tcpUrl:z.string().default('http://127.0.0.1:8080'),preferSocket:z.boolean().default(true),apiToken:z.string()}) as unknown as z<Config>
export interface AgentMeshService {core:SamClient;tools:SamToolClient;inference:SamInferenceClient;operator:SamOperator}
declare module '@deepseek-ai/cordis'{interface Context{agentMesh:AgentMeshService}}
export function apply(ctx:Context,config:Config):void{const core=new SamClient({...(config.socketPath!==undefined?{socketPath:config.socketPath}:{}),...(config.tcpUrl!==undefined?{tcpUrl:config.tcpUrl}:{}),...(config.preferSocket!==undefined?{preferSocket:config.preferSocket}:{}),...(config.apiToken!==undefined?{apiToken:config.apiToken}:{})});ctx.provide('agentMesh',{core,tools:new SamToolClient(core),inference:new SamInferenceClient(core),operator:new SamOperator(core)})}
export { SamClient, SamCoreClient } from './core/index.js'
export { SamToolClient } from './tools/index.js'
export { SamInferenceClient } from './inference/index.js'
export { TaskClient } from './tasks/index.js'
export { SamOperator } from './operator/index.js'
