import {
  type CancelTaskRequest, type CancelTaskResponse, type CollectTaskRequest,
  type CollectTaskResponse, type GetTaskResponse, type JsonObject, type JsonValue,
  type SubmitTaskRequest, type SubmitTaskResponse, type TaskErrorData,
  TaskProtocolError, type TaskSnapshot, type TaskStatus, type WatchTaskRequest, type WatchTaskResponse,
} from './types.js'

/** Minimal transport seam. Implementations can route through any SAM MCP peer. */
export interface RemoteToolCaller {
  callTool(name: string, arguments_: JsonObject, options?: { signal?: AbortSignal }): Promise<unknown>
}

export interface TaskToolNames {
  submit: string; get: string; watch: string; cancel: string; collect: string
}
export const DEFAULT_TASK_TOOLS: Readonly<TaskToolNames> = Object.freeze({
  submit: 'task_submit', get: 'task_get', watch: 'task_watch', cancel: 'task_cancel', collect: 'task_collect',
})
export interface TaskCallOptions { signal?: AbortSignal }
export interface TaskClientOptions { tools?: Partial<TaskToolNames> }

function object(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TaskProtocolError({ code: 'TASK_PROTOCOL_INVALID_RESPONSE', message: `${operation} returned a non-object response` })
  return value as Record<string, unknown>
}
function remoteError(value: Record<string, unknown>): TaskErrorData | undefined {
  const raw = value.error
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const error = raw as Record<string, unknown>
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return undefined
  const out: TaskErrorData = { code: error.code, message: error.message }
  if (typeof error.retryable === 'boolean') out.retryable = error.retryable
  if (error.details !== undefined) out.details = error.details as JsonValue
  return out
}
function response<T>(value: unknown, operation: string): T {
  let raw = object(value, operation)
  // A caller may expose the raw MCP CallToolResult or already unwrap it.
  if (raw.structuredContent !== undefined) raw = object(raw.structuredContent, operation)
  else if (raw.isError === true) {
    const content = Array.isArray(raw.content) ? raw.content : []
    const text = content.map(part => typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : '').filter(Boolean).join('\n')
    throw new TaskProtocolError({ code: 'TASK_REMOTE_ERROR', message: text || `${operation} failed` })
  }
  const error = remoteError(raw)
  if (error) throw new TaskProtocolError(error)
  return raw as T
}
function args(value: object): JsonObject { return value as unknown as JsonObject }


const STATUSES = new Set<TaskStatus>(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'])
function taskFrom(value: unknown, operation: string): TaskSnapshot {
  const task = object(value, operation)
  if (typeof task.taskId !== 'string' || !task.taskId || typeof task.status !== 'string' || !STATUSES.has(task.status as TaskStatus)) {
    throw new TaskProtocolError({ code: 'TASK_PROTOCOL_INVALID_RESPONSE', message: `${operation} returned an invalid task snapshot` })
  }
  return task as unknown as TaskSnapshot
}

/** Client for the version-independent durable task MCP vocabulary. */
export class TaskClient {
  readonly tools: Readonly<TaskToolNames>
  constructor(readonly caller: RemoteToolCaller, options: TaskClientOptions = {}) {
    this.tools = Object.freeze({ ...DEFAULT_TASK_TOOLS, ...options.tools })
  }
  async submit(request: SubmitTaskRequest, options: TaskCallOptions = {}): Promise<SubmitTaskResponse> {
    if (!request.idempotencyKey) throw new TaskProtocolError({ code: 'TASK_IDEMPOTENCY_KEY_REQUIRED', message: 'idempotencyKey is required' })
    const result = response<SubmitTaskResponse>(await this.invoke(this.tools.submit, args(request), options), 'submit')
    taskFrom(result.task, 'submit')
    return result
  }
  async get(taskId: string, options: TaskCallOptions = {}): Promise<TaskSnapshot> {
    const result = response<GetTaskResponse>(await this.invoke(this.tools.get, { taskId }, options), 'get')
    return taskFrom(result.task, 'get')
  }
  async watch(request: string | WatchTaskRequest, options: TaskCallOptions = {}): Promise<WatchTaskResponse> {
    const input = typeof request === 'string' ? { taskId: request } : args(request)
    const result = response<WatchTaskResponse>(await this.invoke(this.tools.watch, input, options), 'watch')
    taskFrom(result.task, 'watch')
    return result
  }
  async cancel(taskId: string, reason?: string, options: TaskCallOptions = {}): Promise<CancelTaskResponse> {
    const input: CancelTaskRequest = reason === undefined ? { taskId } : { taskId, reason }
    const result = response<CancelTaskResponse>(await this.invoke(this.tools.cancel, args(input), options), 'cancel')
    taskFrom(result.task, 'cancel')
    return result
  }
  async collect(request: string | CollectTaskRequest, options: TaskCallOptions = {}): Promise<TaskSnapshot> {
    const input = typeof request === 'string' ? { taskId: request } : args(request)
    const result = response<CollectTaskResponse>(await this.invoke(this.tools.collect, input, options), 'collect')
    return taskFrom(result.task, 'collect')
  }
  private async invoke(name: string, input: JsonObject, options: TaskCallOptions): Promise<unknown> {
    if (options.signal?.aborted) throw new TaskProtocolError({ code: 'TASK_ABORTED', message: 'Task call aborted', retryable: true }, { cause: options.signal.reason })
    try { return await this.caller.callTool(name, input, options.signal === undefined ? undefined : { signal: options.signal }) }
    catch (cause) {
      if (cause instanceof TaskProtocolError) throw cause
      throw new TaskProtocolError({ code: 'TASK_TRANSPORT_ERROR', message: cause instanceof Error ? cause.message : String(cause), retryable: true }, { cause })
    }
  }
}
