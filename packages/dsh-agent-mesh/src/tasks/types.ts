/** JSON values accepted by MCP tools. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type TaskId = string
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
export type TerminalTaskStatus = Extract<TaskStatus, 'succeeded' | 'failed' | 'cancelled' | 'expired'>

export interface TaskIdentity {
  taskId: TaskId
  parentTaskId?: TaskId
  sessionId?: string
  agentId?: string
}

export interface TaskArtifact {
  /** Stable artifact identifier within a task. */
  id: string
  name?: string
  uri: string
  mediaType?: string
  sizeBytes?: number
  digest?: string
  metadata?: JsonObject
}

/** Serializable error sent across the task protocol. */
export interface TaskErrorData {
  code: string
  message: string
  retryable?: boolean
  details?: JsonValue
}

export interface SubmitTaskRequest {
  /** Durable deduplication key. Retrying a submit with this key must return the same task. */
  idempotencyKey: string
  input: JsonValue
  kind?: string
  deadline?: string
  parentTaskId?: TaskId
  sessionId?: string
  agentId?: string
  metadata?: JsonObject
}

export interface TaskSnapshot extends TaskIdentity {
  status: TaskStatus
  createdAt: string
  updatedAt: string
  kind?: string
  deadline?: string
  input?: JsonValue
  output?: JsonValue
  artifacts?: TaskArtifact[]
  error?: TaskErrorData
  metadata?: JsonObject
  revision?: number
}

export interface SubmitTaskResponse { task: TaskSnapshot; deduplicated?: boolean }
export interface GetTaskRequest { taskId: TaskId }
export interface GetTaskResponse { task: TaskSnapshot }

export interface WatchTaskRequest {
  taskId: TaskId
  /** Resume cursor returned by a previous watch. */
  cursor?: string
  /** Server-side long poll bound. */
  waitMs?: number
}
export interface TaskEvent {
  taskId: TaskId
  type: 'snapshot' | 'progress' | 'artifact' | 'log'
  at: string
  cursor?: string
  snapshot?: TaskSnapshot
  progress?: number
  artifact?: TaskArtifact
  data?: JsonValue
}
export interface WatchTaskResponse {
  task: TaskSnapshot
  events?: TaskEvent[]
  cursor?: string
}

export interface CancelTaskRequest { taskId: TaskId; reason?: string }
export interface CancelTaskResponse { task: TaskSnapshot; accepted: boolean }
export interface CollectTaskRequest { taskId: TaskId; deadline?: string; waitMs?: number }
export interface CollectTaskResponse { task: TaskSnapshot }

export type TaskRequest = SubmitTaskRequest | GetTaskRequest | WatchTaskRequest | CancelTaskRequest | CollectTaskRequest
export type TaskResponse = SubmitTaskResponse | GetTaskResponse | WatchTaskResponse | CancelTaskResponse | CollectTaskResponse

export function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired'
}

export function taskSucceeded(task: TaskSnapshot): boolean { return task.status === 'succeeded' }

/** Error raised for both protocol failures and structured remote task errors. */
export class TaskProtocolError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: JsonValue
  readonly cause?: unknown

  constructor(error: TaskErrorData, options: { cause?: unknown } = {}) {
    super(error.message)
    this.name = 'TaskProtocolError'
    this.code = error.code
    this.retryable = error.retryable ?? false
    if (error.details !== undefined) this.details = error.details
    if (options.cause !== undefined) this.cause = options.cause
  }
}
