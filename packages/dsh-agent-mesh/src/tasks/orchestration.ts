import { TaskClient, type TaskCallOptions } from './client.js'
import { type SubmitTaskRequest, type SubmitTaskResponse, type TaskSnapshot } from './types.js'

export interface ConcurrencyOptions extends TaskCallOptions { concurrency?: number }
export type CollectionOrder = 'input' | 'completion'
export interface CollectManyOptions extends ConcurrencyOptions {
  order?: CollectionOrder
  deadline?: string
  waitMs?: number
}

function limit(value = 4): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('concurrency must be a positive safe integer')
  return value
}

/** Map promises through a rolling bounded pool; returned values preserve input order. */
export async function mapBounded<T, R>(
  values: readonly T[], worker: (value: T, index: number) => Promise<R>, concurrency = 4,
): Promise<R[]> {
  const width = limit(concurrency)
  const output = new Array<R>(values.length)
  let next = 0
  async function run(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= values.length) return
      const value = values[index]
      if (value === undefined && !(index in values)) continue
      output[index] = await worker(value as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, run))
  return output
}

/** Submit a fan-out using bounded concurrency. Results correspond to requests. */
export function submitTasks(client: TaskClient, requests: readonly SubmitTaskRequest[], options: ConcurrencyOptions = {}): Promise<SubmitTaskResponse[]> {
  return mapBounded(requests, request => client.submit(request, options), limit(options.concurrency))
}

/** Collect terminal task snapshots in input or completion order. */
export async function collectTasks(
  client: TaskClient, taskIds: readonly string[], options: CollectManyOptions = {},
): Promise<TaskSnapshot[]> {
  if ((options.order ?? 'input') === 'completion') {
    const result: TaskSnapshot[] = []
    for await (const item of collectTasksAsCompleted(client, taskIds, options)) result.push(item.task)
    return result
  }
  return mapBounded(taskIds, taskId => client.collect({
    taskId,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  }, options), limit(options.concurrency))
}

export interface CompletedTask { index: number; taskId: string; task: TaskSnapshot }

/**
 * Rolling-pool async iterator. Starts no more than `concurrency` collects and
 * yields each result as soon as it settles. Abandoning iteration prevents new work.
 */
export async function* collectTasksAsCompleted(
  client: TaskClient, taskIds: readonly string[], options: ConcurrencyOptions & { deadline?: string; waitMs?: number } = {},
): AsyncGenerator<CompletedTask> {
  const width = limit(options.concurrency)
  let next = 0
  type Settled = { token: number; item: CompletedTask }
  const active = new Map<number, Promise<Settled>>()
  const start = (index: number): void => {
    const taskId = taskIds[index]
    if (taskId === undefined) return
    const request = {
      taskId,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    }
    active.set(index, client.collect(request, options).then(task => ({ token: index, item: { index, taskId, task } })))
  }
  while (next < taskIds.length && active.size < width) start(next++)
  while (active.size > 0) {
    const settled = await Promise.race(active.values())
    active.delete(settled.token)
    if (next < taskIds.length) start(next++)
    yield settled.item
  }
}

/** Submit then collect a request fan-out. Each request is idempotently admitted first. */
export async function runTasks(
  client: TaskClient, requests: readonly SubmitTaskRequest[], options: CollectManyOptions = {},
): Promise<TaskSnapshot[]> {
  const submitted = await submitTasks(client, requests, options)
  return collectTasks(client, submitted.map(value => value.task.taskId), options)
}

/** Explicitly named ordered collection helper. */
export function collectTasksOrdered(client: TaskClient, taskIds: readonly string[], options: Omit<CollectManyOptions, 'order'> = {}): Promise<TaskSnapshot[]> {
  return collectTasks(client, taskIds, { ...options, order: 'input' })
}

/** Short alias for callers that prefer collection-strategy terminology. */
export const collectAsCompleted = collectTasksAsCompleted
/** Short alias for bounded fan-out admission. */
export const submitAll = submitTasks
