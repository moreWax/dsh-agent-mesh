import type { JsonValue, TaskSnapshot } from './types.js'
import type { TaskExecutionContext, TaskExecutionResult, TaskExecutor } from './service.js'

export interface DshContentBlock { type: string; text?: string; [key: string]: unknown }
export interface DshSubagentResult { output: DshContentBlock[]; stopReason: string; structured?: unknown; diagnostic?: string }
export interface DshSubagentRun { result: Promise<DshSubagentResult>; dispose(): void | Promise<void> }
export interface DshSubagentRuntime {
  start(provider: string, request: { prompt: DshContentBlock[]; parent: unknown; signal: AbortSignal; label?: string; agentOptions?: unknown }): Promise<DshSubagentRun>
}
export interface PrimeSessionRun { sessionId?: string; result: Promise<unknown>; cancel?(reason?: unknown): void | Promise<void>; dispose?(): void | Promise<void> }
export interface PrimeSessionRuntime { start(request: { prompt: string; signal: AbortSignal; task: TaskSnapshot }): Promise<PrimeSessionRun> }
export interface DshTaskExecutorOptions { subagents?: DshSubagentRuntime; parent?: unknown | ((task: TaskSnapshot) => unknown); provider?: string; prime?: PrimeSessionRuntime }

function prompt(input: JsonValue | undefined): string { return typeof input === 'string' ? input : JSON.stringify(input ?? null) }
function text(blocks: DshContentBlock[]): string { return blocks.filter(x=>x.type==='text').map(x=>x.text??'').join('') }
/** Adapter for the cleanroom `ctx.subagents.start()` seam or a Prime durable session bridge. */
export class DshTaskExecutor implements TaskExecutor {
  constructor(private readonly options: DshTaskExecutorOptions) { if (!options.subagents && !options.prime) throw new Error('DshTaskExecutor requires subagents or prime') }
  async execute(task: TaskSnapshot, context: TaskExecutionContext): Promise<TaskExecutionResult> {
    if (this.options.prime) return this.executePrime(task, context)
    const runtime=this.options.subagents!, parent=typeof this.options.parent==='function'?this.options.parent(task):this.options.parent
    if(parent===undefined)throw new Error('dsh subagent execution requires a parent Agent')
    const run=await runtime.start(this.options.provider??task.agentId??'in-process',{prompt:[{type:'text',text:prompt(task.input)}],parent,signal:context.signal,...(task.kind?{label:task.kind}:{})})
    const abort=()=>void run.dispose();context.signal.addEventListener('abort',abort,{once:true})
    try { const result=await run.result;if(result.stopReason!=='completed')throw Object.assign(new Error(result.diagnostic??`subagent stopped: ${result.stopReason}`),{code:result.stopReason==='aborted'?'TASK_ABORTED':'DSH_SUBAGENT_FAILED'});return {output:(result.structured??text(result.output)) as JsonValue} }
    finally { context.signal.removeEventListener('abort',abort);await run.dispose() }
  }
  private async executePrime(task:TaskSnapshot,context:TaskExecutionContext):Promise<TaskExecutionResult>{const run=await this.options.prime!.start({prompt:prompt(task.input),signal:context.signal,task});if(run.sessionId)await context.log({primeSessionId:run.sessionId});const abort=()=>void run.cancel?.(context.signal.reason);context.signal.addEventListener('abort',abort,{once:true});try{return {output:(await run.result) as JsonValue}}finally{context.signal.removeEventListener('abort',abort);await run.dispose?.()}}
}
