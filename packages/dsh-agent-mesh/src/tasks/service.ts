import { randomUUID } from 'node:crypto'
import { ToolRegistry, type ToolDescriptor } from './tools.js'
import {
  isTerminalStatus, TaskProtocolError, type CancelTaskRequest, type CancelTaskResponse,
  type CollectTaskRequest, type CollectTaskResponse, type GetTaskRequest, type GetTaskResponse,
  type JsonObject, type JsonValue, type SubmitTaskRequest, type SubmitTaskResponse,
  type TaskArtifact, type TaskErrorData, type TaskEvent, type TaskSnapshot,
  type WatchTaskRequest, type WatchTaskResponse,
} from './types.js'

export interface StoredTask {
  task: TaskSnapshot
  idempotencyKey: string
  /** Canonical admission payload; stores use this to reject accidental key reuse. */
  requestFingerprint: string
}
export interface TaskAdmission { record: StoredTask; deduplicated: boolean; conflict?: boolean }
export interface TaskMutation { task: TaskSnapshot; events?: Omit<TaskEvent, 'taskId' | 'at' | 'cursor'>[] }
export interface TaskEventPage { events: TaskEvent[]; cursor: string }

/**
 * Persistence boundary for task services and workers. Implementations must make
 * admit and compareAndSet atomic across processes. All returned values are
 * detached copies. waitForChange may be implemented with notifications or polling.
 */
export interface TaskStore {
  admit(record: StoredTask): Promise<TaskAdmission>
  get(taskId: string): Promise<StoredTask | undefined>
  compareAndSet(taskId: string, expectedRevision: number, mutation: TaskMutation): Promise<StoredTask | undefined>
  events(taskId: string, afterCursor?: string): Promise<TaskEventPage>
  waitForChange(taskId: string, afterRevision: number, waitMs: number, signal?: AbortSignal): Promise<void>
}

export interface TaskExecutionContext {
  signal: AbortSignal
  progress(value: number, data?: JsonValue): Promise<void>
  artifact(artifact: TaskArtifact): Promise<void>
  log(data: JsonValue): Promise<void>
}
export interface TaskExecutionResult { output?: JsonValue; artifacts?: TaskArtifact[] }
/** Executor boundary: adapters can enqueue to Prime/dsh workers or run locally. */
export interface TaskExecutor {
  execute(task: TaskSnapshot, context: TaskExecutionContext): Promise<TaskExecutionResult | JsonValue | void>
}
export interface TaskServiceOptions {
  concurrency?: number
  now?: () => Date
  id?: () => string
  /** Start locally executing newly admitted tasks. Disable when an external durable worker claims them. */
  autoStart?: boolean
}

type Waiter = { revision: number; resolve: () => void }
function clone<T>(value: T): T { return structuredClone(value) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
function protocol(code: string, message: string, retryable = false, details?: JsonValue): TaskProtocolError {
  return new TaskProtocolError({ code, message, retryable, ...(details === undefined ? {} : { details }) })
}
function revision(task: TaskSnapshot): number { return task.revision ?? 0 }
function cursorNumber(cursor?: string): number {
  if (cursor === undefined) return 0
  const n = Number(cursor)
  if (!Number.isSafeInteger(n) || n < 0) throw protocol('TASK_CURSOR_INVALID', 'cursor must be a non-negative integer')
  return n
}

/** Reference store. It documents the atomic semantics expected from database-backed stores. */
export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, StoredTask>()
  private readonly keys = new Map<string, string>()
  private readonly histories = new Map<string, TaskEvent[]>()
  private readonly sequence = new Map<string, number>()
  private readonly waiters = new Map<string, Set<Waiter>>()

  async admit(input: StoredTask): Promise<TaskAdmission> {
    const existingId = this.keys.get(input.idempotencyKey)
    if (existingId !== undefined) {
      const record = this.records.get(existingId)!
      return { record: clone(record), deduplicated: true, conflict: record.requestFingerprint !== input.requestFingerprint }
    }
    const record = clone(input)
    this.records.set(record.task.taskId, record)
    this.keys.set(record.idempotencyKey, record.task.taskId)
    this.histories.set(record.task.taskId, [])
    this.append(record.task.taskId, [{ type: 'snapshot', snapshot: record.task }])
    return { record: clone(record), deduplicated: false }
  }
  async get(taskId: string): Promise<StoredTask | undefined> { const value = this.records.get(taskId); return value && clone(value) }
  async compareAndSet(taskId: string, expectedRevision: number, mutation: TaskMutation): Promise<StoredTask | undefined> {
    const current = this.records.get(taskId)
    if (!current || revision(current.task) !== expectedRevision) return undefined
    const next = clone(mutation.task)
    if (next.taskId !== taskId || revision(next) !== expectedRevision + 1) throw new Error('mutation must preserve taskId and increment revision once')
    const stored = { ...current, task: next }
    this.records.set(taskId, stored)
    this.append(taskId, [{ type: 'snapshot', snapshot: next }, ...(mutation.events ?? [])])
    for (const waiter of this.waiters.get(taskId) ?? []) if (revision(next) > waiter.revision) waiter.resolve()
    return clone(stored)
  }
  async events(taskId: string, afterCursor?: string): Promise<TaskEventPage> {
    if (!this.records.has(taskId)) throw protocol('TASK_NOT_FOUND', `Task ${taskId} was not found`)
    const after = cursorNumber(afterCursor)
    const events = (this.histories.get(taskId) ?? []).filter(event => Number(event.cursor) > after)
    return { events: clone(events), cursor: String(this.sequence.get(taskId) ?? 0) }
  }
  async waitForChange(taskId: string, afterRevision: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    const current = this.records.get(taskId)
    if (!current) throw protocol('TASK_NOT_FOUND', `Task ${taskId} was not found`)
    if (revision(current.task) > afterRevision || waitMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const set = this.waiters.get(taskId) ?? new Set<Waiter>(); this.waiters.set(taskId, set)
      let done = false
      const finish = (): void => { if (done) return; done = true; clearTimeout(timer); set.delete(waiter); signal?.removeEventListener('abort', abort); resolve() }
      const abort = (): void => { if (done) return; done = true; clearTimeout(timer); set.delete(waiter); reject(signal?.reason ?? protocol('TASK_ABORTED', 'Task wait aborted', true)) }
      const waiter = { revision: afterRevision, resolve: finish }; set.add(waiter)
      const timer = setTimeout(finish, waitMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  private append(taskId: string, inputs: Omit<TaskEvent, 'taskId' | 'at' | 'cursor'>[]): void {
    const history = this.histories.get(taskId)!; let seq = this.sequence.get(taskId) ?? 0
    for (const input of inputs) history.push({ ...clone(input), taskId, at: new Date().toISOString(), cursor: String(++seq) } as TaskEvent)
    this.sequence.set(taskId, seq)
  }
}

export class TaskService {
  private readonly concurrency: number
  private readonly now: () => Date
  private readonly id: () => string
  private readonly autoStart: boolean
  private active = 0
  private readonly pending: string[] = []
  private readonly pendingSet = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private accepting = true
  private readonly idleWaiters = new Set<() => void>()

  readonly tools = new ToolRegistry()
  /** Attached by withPairing; undefined when pairing is not mounted. */
  pairing: import('./pairing.js').PairingStore | undefined
  pairInviteFor: (() => string) | undefined

  constructor(readonly store: TaskStore, readonly executor: TaskExecutor, options: TaskServiceOptions = {}) {
    this.concurrency = options.concurrency ?? 4
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) throw new RangeError('concurrency must be a positive safe integer')
    this.now = options.now ?? (() => new Date()); this.id = options.id ?? randomUUID; this.autoStart = options.autoStart ?? true
    for (const tool of taskServiceTools(this)) this.tools.register(tool)
  }
  async task_submit(request: SubmitTaskRequest): Promise<SubmitTaskResponse> {
    if (!this.accepting) throw protocol('TASK_SERVICE_STOPPING', 'Task service is shutting down', true)
    if (!request.idempotencyKey) throw protocol('TASK_IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required')
    const deadline = request.deadline === undefined ? undefined : this.parseDeadline(request.deadline)
    const at = this.now().toISOString(); const taskId = this.id()
    const task: TaskSnapshot = { taskId, status: deadline !== undefined && deadline <= this.now().getTime() ? 'expired' : 'queued', createdAt: at, updatedAt: at, input: clone(request.input), revision: 0,
      ...(request.kind === undefined ? {} : { kind: request.kind }), ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
      ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }), ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }), ...(request.metadata === undefined ? {} : { metadata: clone(request.metadata) }) }
    if (task.status === 'expired') task.error = { code: 'TASK_DEADLINE_EXCEEDED', message: 'Task deadline elapsed before admission', retryable: false }
    const fingerprint = canonical({ ...request, idempotencyKey: undefined })
    const admitted = await this.store.admit({ task, idempotencyKey: request.idempotencyKey, requestFingerprint: fingerprint })
    if (admitted.conflict) throw protocol('TASK_IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for a different request')
    if (!admitted.deduplicated && admitted.record.task.status === 'queued' && this.autoStart) this.enqueue(taskId)
    return { task: admitted.record.task, ...(admitted.deduplicated ? { deduplicated: true } : {}) }
  }
  async task_get(request: GetTaskRequest): Promise<GetTaskResponse> { return { task: (await this.required(request.taskId)).task } }
  async task_watch(request: WatchTaskRequest, signal?: AbortSignal): Promise<WatchTaskResponse> {
    const waitMs = this.wait(request.waitMs)
    let record = await this.required(request.taskId)
    let page = await this.store.events(request.taskId, request.cursor)
    if (page.events.length === 0 && waitMs > 0 && !isTerminalStatus(record.task.status)) {
      await this.store.waitForChange(request.taskId, revision(record.task), waitMs, signal)
      record = await this.required(request.taskId); page = await this.store.events(request.taskId, request.cursor)
    }
    return { task: record.task, events: page.events, cursor: page.cursor }
  }
  async task_cancel(request: CancelTaskRequest): Promise<CancelTaskResponse> {
    while (true) {
      const record = await this.required(request.taskId)
      if (isTerminalStatus(record.task.status)) return { task: record.task, accepted: false }
      const next: TaskSnapshot = { ...record.task, status: 'cancelled', updatedAt: this.now().toISOString(), revision: revision(record.task) + 1,
        error: { code: 'TASK_CANCELLED', message: request.reason ?? 'Task was cancelled', retryable: false } }
      const changed = await this.store.compareAndSet(request.taskId, revision(record.task), { task: next })
      if (changed) { this.controllers.get(request.taskId)?.abort(next.error); return { task: changed.task, accepted: true } }
    }
  }
  async task_collect(request: CollectTaskRequest, signal?: AbortSignal): Promise<CollectTaskResponse> {
    const absolute = request.deadline === undefined ? undefined : this.parseDeadline(request.deadline)
    const bounded = request.waitMs === undefined ? Infinity : this.wait(request.waitMs)
    const end = Math.min(absolute ?? Infinity, this.now().getTime() + bounded)
    while (true) {
      const record = await this.required(request.taskId)
      if (isTerminalStatus(record.task.status)) return { task: record.task }
      const remaining = end - this.now().getTime()
      if (remaining <= 0) throw protocol('TASK_COLLECT_TIMEOUT', 'Task did not finish before collect deadline', true)
      await this.store.waitForChange(request.taskId, revision(record.task), Math.min(remaining, 30_000), signal)
    }
  }
  /** Claim and execute a queued task. Durable worker loops can call this explicitly. */
  async execute(taskId: string): Promise<TaskSnapshot> {
    let record = await this.required(taskId)
    if (record.task.status !== 'queued') return record.task
    if (record.task.deadline !== undefined && this.parseDeadline(record.task.deadline) <= this.now().getTime()) return this.finish(taskId, 'expired', undefined, { code: 'TASK_DEADLINE_EXCEEDED', message: 'Task deadline elapsed', retryable: false })
    const running: TaskSnapshot = { ...record.task, status: 'running', updatedAt: this.now().toISOString(), revision: revision(record.task) + 1 }
    const claimed = await this.store.compareAndSet(taskId, revision(record.task), { task: running })
    if (!claimed) return (await this.required(taskId)).task
    record = claimed
    const controller = new AbortController(); this.controllers.set(taskId, controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    if (running.deadline !== undefined) timer = setTimeout(() => controller.abort({ code: 'TASK_DEADLINE_EXCEEDED' }), Math.max(0, this.parseDeadline(running.deadline) - this.now().getTime()))
    const context: TaskExecutionContext = {
      signal: controller.signal,
      progress: async (value, data) => { if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('progress must be between 0 and 1'); await this.emit(taskId, { type: 'progress', progress: value, ...(data === undefined ? {} : { data }) }) },
      artifact: async artifact => { await this.addArtifact(taskId, artifact) },
      log: async data => { await this.emit(taskId, { type: 'log', data }) },
    }
    try {
      const result = await this.executor.execute(claimed.task, context)
      const latest = await this.required(taskId); if (isTerminalStatus(latest.task.status)) return latest.task
      if (controller.signal.aborted) return this.expireOrCancel(taskId, running.deadline)
      const normalized: TaskExecutionResult = result !== undefined && typeof result === 'object' && result !== null && !Array.isArray(result) && ('output' in result || 'artifacts' in result) ? result as TaskExecutionResult : (result === undefined ? {} : { output: result as JsonValue })
      for (const artifact of normalized.artifacts ?? []) await this.addArtifact(taskId, artifact)
      return this.finish(taskId, 'succeeded', normalized.output)
    } catch (cause) {
      const latest = await this.required(taskId); if (isTerminalStatus(latest.task.status)) return latest.task
      if (controller.signal.aborted) return this.expireOrCancel(taskId, running.deadline)
      return this.finish(taskId, 'failed', undefined, this.error(cause))
    } finally { if (timer) clearTimeout(timer); this.controllers.delete(taskId) }
  }
  /** Stop admission, cancel queued/running work, and wait boundedly for executors to settle. */
  async shutdown(options: { waitMs?: number } = {}): Promise<void> {
    this.accepting = false
    const ids = [...this.pending]
    this.pending.length = 0; this.pendingSet.clear()
    await Promise.all(ids.map(id => this.task_cancel({ taskId: id, reason: 'Task service is shutting down' }).catch(() => undefined)))
    for (const controller of this.controllers.values()) controller.abort(protocol('TASK_SERVICE_STOPPING', 'Task service is shutting down', true))
    if (this.active === 0) return
    const waitMs = options.waitMs ?? 5_000
    await new Promise<void>(resolve => { const done = (): void => { clearTimeout(timer); this.idleWaiters.delete(done); resolve() }; const timer = setTimeout(done, waitMs); this.idleWaiters.add(done) })
  }
  /** Tool-caller compatible dispatch surface for MCP/dsh adapters. */
  /** In-process dispatch (trusted edge — transport authz lives in http.ts). */
  async callTool(name: string, arguments_: JsonObject, options?: { signal?: AbortSignal }): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw protocol('TASK_TOOL_NOT_FOUND', `Unknown task tool: ${name}`)
    return tool.handler(arguments_, { signal: options?.signal })
  }

  private requirePairing(): import('./pairing.js').PairingStore {
    if (!this.pairing || !this.pairInviteFor) throw protocol('TASK_PAIRING_DISABLED', 'This service does not accept fleet pairings')
    return this.pairing
  }

  /** Operator surfaces (web card, in-process callers) — same store the mesh tools use. */
  pairPending(): import('./pairing.js').PairRequest[] { return this.requirePairing().pending() }
  pairApprove(requestId: string, approvedBy: string): { requestId: string; label: string } {
    const approved = this.requirePairing().approve(requestId, this.pairInviteFor!(), approvedBy)
    if (!approved) throw protocol('TASK_PAIRING_UNKNOWN', 'No pending request with that id (expired, approved, or unknown)')
    return { requestId: approved.requestId, label: approved.label }
  }
  pairReject(requestId: string): boolean { return this.requirePairing().reject(requestId) }

  private enqueue(taskId: string): void { if (this.pendingSet.has(taskId)) return; this.pendingSet.add(taskId); this.pending.push(taskId); this.pump() }
  private pump(): void { while (this.active < this.concurrency) { const id = this.pending.shift(); if (!id) return; this.pendingSet.delete(id); this.active++; void this.execute(id).finally(() => { this.active--; if (this.active === 0) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() } this.pump() }) } }
  private async required(taskId: string): Promise<StoredTask> { const record = await this.store.get(taskId); if (!record) throw protocol('TASK_NOT_FOUND', `Task ${taskId} was not found`); return record }
  private parseDeadline(value: string): number { const time = Date.parse(value); if (!Number.isFinite(time)) throw protocol('TASK_DEADLINE_INVALID', 'deadline must be an ISO-8601 timestamp'); return time }
  private wait(value?: number): number { const n = value ?? 0; if (!Number.isSafeInteger(n) || n < 0) throw protocol('TASK_WAIT_INVALID', 'waitMs must be a non-negative safe integer'); return n }
  private async mutate(taskId: string, fn: (task: TaskSnapshot) => TaskMutation | undefined): Promise<TaskSnapshot> { while (true) { const record = await this.required(taskId); const mutation = fn(record.task); if (!mutation) return record.task; const changed = await this.store.compareAndSet(taskId, revision(record.task), mutation); if (changed) return changed.task } }
  private async emit(taskId: string, event: Omit<TaskEvent, 'taskId' | 'at' | 'cursor'>): Promise<void> { await this.mutate(taskId, task => isTerminalStatus(task.status) ? undefined : { task: { ...task, updatedAt: this.now().toISOString(), revision: revision(task) + 1 }, events: [event] }) }
  private async addArtifact(taskId: string, artifact: TaskArtifact): Promise<void> { await this.mutate(taskId, task => isTerminalStatus(task.status) ? undefined : { task: { ...task, artifacts: [...(task.artifacts ?? []).filter(a => a.id !== artifact.id), clone(artifact)], updatedAt: this.now().toISOString(), revision: revision(task) + 1 }, events: [{ type: 'artifact', artifact: clone(artifact) }] }) }
  private async finish(taskId: string, status: 'succeeded' | 'failed' | 'expired', output?: JsonValue, error?: TaskErrorData): Promise<TaskSnapshot> { return this.mutate(taskId, task => isTerminalStatus(task.status) ? undefined : { task: { ...task, status, updatedAt: this.now().toISOString(), revision: revision(task) + 1, ...(output === undefined ? {} : { output: clone(output) }), ...(error === undefined ? {} : { error }) } }) }
  private expireOrCancel(taskId: string, deadline?: string): Promise<TaskSnapshot> { const expired = deadline !== undefined && this.parseDeadline(deadline) <= this.now().getTime(); return this.finish(taskId, expired ? 'expired' : 'failed', undefined, expired ? { code: 'TASK_DEADLINE_EXCEEDED', message: 'Task deadline elapsed', retryable: false } : { code: 'TASK_ABORTED', message: 'Task execution aborted', retryable: true }) }
  private error(cause: unknown): TaskErrorData { if (cause instanceof TaskProtocolError) return { code: cause.code, message: cause.message, retryable: cause.retryable, ...(cause.details === undefined ? {} : { details: cause.details }) }; return { code: 'TASK_EXECUTION_FAILED', message: cause instanceof Error ? cause.message : String(cause), retryable: false } }
}

/** The five task tools as descriptors — registration order is pinned by tests. */
function taskServiceTools(service: TaskService): ToolDescriptor[] {
  const obj = (required: string[], properties: Record<string, unknown>): Record<string, unknown> =>
    ({ type: 'object', required, properties, additionalProperties: false })
  const taskId = { taskId: { type: 'string', minLength: 1 } }
  return [
    { name: 'task_submit', description: 'Submit an idempotent durable task', auth: 'capability',
      schema: obj(['idempotencyKey', 'input'], { idempotencyKey: { type: 'string', minLength: 1 }, input: {}, kind: { type: 'string' }, deadline: { type: 'string', format: 'date-time' }, parentTaskId: { type: 'string' }, sessionId: { type: 'string' }, agentId: { type: 'string' }, metadata: { type: 'object' } }),
      handler: (args, ctx) => service.task_submit(args as unknown as SubmitTaskRequest) },
    { name: 'task_get', description: 'Get a task snapshot', auth: 'capability',
      schema: obj(['taskId'], taskId),
      handler: (args) => service.task_get(args as unknown as GetTaskRequest) },
    { name: 'task_watch', description: 'Long-poll task events from a cursor', auth: 'capability',
      schema: obj(['taskId'], { ...taskId, cursor: { type: 'string' }, waitMs: { type: 'integer', minimum: 0 } }),
      handler: (args, ctx) => service.task_watch(args as unknown as WatchTaskRequest, ctx.signal) },
    { name: 'task_cancel', description: 'Cancel queued or running task execution', auth: 'capability',
      schema: obj(['taskId'], { ...taskId, reason: { type: 'string' } }),
      handler: (args) => service.task_cancel(args as unknown as CancelTaskRequest) },
    { name: 'task_collect', description: 'Wait for a terminal task snapshot', auth: 'capability',
      schema: obj(['taskId'], { ...taskId, deadline: { type: 'string', format: 'date-time' }, waitMs: { type: 'integer', minimum: 0 } }),
      handler: (args, ctx) => service.task_collect(args as unknown as CollectTaskRequest, ctx.signal) },
  ]
}
