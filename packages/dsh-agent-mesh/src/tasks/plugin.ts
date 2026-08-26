import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentMeshService } from '../index.js'
import { InMemoryTaskStore, TaskService, type TaskExecutor } from './service.js'
import { TaskHttpServer } from './http.js'
import { SamTaskRegistrationClient } from './registration.js'
export const name='agent-mesh-task-service'
export const inject=['agentMesh']
export interface Config { host?: string; port?: number; path?: string; healthPath?: string; serviceName?: string; registerWithSam?: boolean; shutdownTimeoutMs?: number }
export const Config:z<Config>=z.object({host:z.string().default('127.0.0.1'),port:z.natural().default(0),path:z.string().default('/mcp'),healthPath:z.string().default('/healthz'),serviceName:z.string().default('dsh-task-service'),registerWithSam:z.boolean().default(true),shutdownTimeoutMs:z.natural().default(5000)}) as unknown as z<Config>
declare module '@deepseek-ai/cordis' { interface Context { agentMeshTaskService: TaskService } }
export const provide=['agentMeshTaskService']
export async function apply(ctx:Context,config:Config):Promise<void>{
  const executor:TaskExecutor={async execute(task){return task.input ?? null}}
  const service=new TaskService(new InMemoryTaskStore(),executor)
  const server=new TaskHttpServer(service,config); const address=await server.start(); ctx.provide('agentMeshTaskService',service)
  let registration:Awaited<ReturnType<SamTaskRegistrationClient['register']>>|undefined
  const registry=new SamTaskRegistrationClient((ctx as Context & {agentMesh:AgentMeshService}).agentMesh.core)
  let retryTimer:ReturnType<typeof setInterval>|undefined
  if(config.registerWithSam!==false){
    // Registration must never fail the boot: the node may be auto-starting
    // concurrently (plugin row ordering is not a readiness contract), or simply
    // absent. Attempt inline, then retry on a slow bounded loop; the service
    // stays local-only until a retry lands.
    const attempt=async():Promise<boolean>=>{
      try{ registration=await registry.register(address,config.serviceName === undefined ? {} : {name:config.serviceName}); return true }
      catch(error){ ctx.logger.warn(`task service SAM registration failed (will retry): ${error instanceof Error?error.message:String(error)}`); return false }
    }
    if(!await attempt()){
      let attempts=0
      retryTimer=setInterval(()=>{attempts+=1;void attempt().then(ok=>{if(ok){ctx.logger.info('task service registered with SAM after retry');clearInterval(retryTimer)}else if(attempts>=40){ctx.logger.warn('task service SAM registration gave up after 40 attempts; service stays local-only');clearInterval(retryTimer)}})},5_000)
      retryTimer.unref?.()
    }
  }
  ctx.effect(()=>async()=>{if(retryTimer)clearInterval(retryTimer);if(registration) await registry.unregister(registration).catch(error=>ctx.logger.warn(`task service unregister failed: ${error instanceof Error?error.message:String(error)}`));await server.stop()},'agent-mesh-task-service.lifecycle')
}
