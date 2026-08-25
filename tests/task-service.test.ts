import { describe, expect, it } from 'vitest'
import { InMemoryTaskStore, TaskClient, TaskProtocolError, TaskService, type TaskExecutor } from '../src/tasks/index.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
describe('TaskService', () => {
  it('runs through the client, watches events and collects artifacts/output', async () => {
    const executor: TaskExecutor = { async execute(task, context) { await context.progress(.5, { phase: 'work' }); await context.artifact({ id: 'a', uri: 'memory:a' }); return { output: { echo: task.input ?? null } } } }
    const service = new TaskService(new InMemoryTaskStore(), executor, { concurrency: 2, id: () => 't1' })
    const client = new TaskClient(service)
    const submitted = await client.submit({ idempotencyKey: 'one', input: 'hello' })
    expect(submitted.task.status).toBe('queued')
    const task = await client.collect({ taskId: 't1', waitMs: 1000 })
    expect(task).toMatchObject({ status: 'succeeded', output: { echo: 'hello' }, artifacts: [{ id: 'a' }] })
    const watched = await client.watch({ taskId: 't1', cursor: '0' })
    expect(watched.events?.map(e => e.type)).toEqual(expect.arrayContaining(['progress', 'artifact', 'snapshot']))
    expect(Number(watched.cursor)).toBeGreaterThan(0)
  })
  it('deduplicates identical submission and rejects key reuse', async () => {
    let calls = 0
    const service = new TaskService(new InMemoryTaskStore(), { async execute() { calls++; return null } }, { id: () => 'same' })
    const first = await service.task_submit({ idempotencyKey: 'key', input: { a: 1, b: 2 } })
    const duplicate = await service.task_submit({ idempotencyKey: 'key', input: { b: 2, a: 1 } })
    expect(duplicate).toMatchObject({ deduplicated: true, task: { taskId: first.task.taskId } })
    await expect(service.task_submit({ idempotencyKey: 'key', input: { a: 3 } })).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' })
    await service.task_collect({ taskId: 'same', waitMs: 1000 })
    expect(calls).toBe(1)
  })
  it('enforces concurrency and cancellation', async () => {
    let live = 0, max = 0
    const service = new TaskService(new InMemoryTaskStore(), { async execute(_task, context) { live++; max = Math.max(max, live); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); context.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) }); live--; return 'done' } }, { concurrency: 1, id: (() => { let n = 0; return () => `t${++n}` })() })
    await Promise.all([service.task_submit({ idempotencyKey: '1', input: null }), service.task_submit({ idempotencyKey: '2', input: null })])
    await sleep(10)
    expect((await service.task_cancel({ taskId: 't1', reason: 'stop' }))).toMatchObject({ accepted: true, task: { status: 'cancelled' } })
    expect((await service.task_collect({ taskId: 't2', waitMs: 1000 })).task.status).toBe('succeeded')
    expect(max).toBe(1)
  })
  it('expires deadlines and preserves structured failures', async () => {
    const service = new TaskService(new InMemoryTaskStore(), { async execute() { throw new TaskProtocolError({ code: 'WORKER_BAD', message: 'broken', retryable: true, details: { n: 1 } }) } }, { id: (() => { let n = 0; return () => `x${++n}` })() })
    const expired = await service.task_submit({ idempotencyKey: 'past', input: null, deadline: new Date(0).toISOString() })
    expect(expired.task).toMatchObject({ status: 'expired', error: { code: 'TASK_DEADLINE_EXCEEDED' } })
    await service.task_submit({ idempotencyKey: 'fail', input: null })
    expect((await service.task_collect({ taskId: 'x2', waitMs: 1000 })).task).toMatchObject({ status: 'failed', error: { code: 'WORKER_BAD', retryable: true, details: { n: 1 } } })
  })
  it('supports external workers with autoStart false and CAS claiming', async () => {
    let calls = 0
    const service = new TaskService(new InMemoryTaskStore(), { async execute() { calls++; return 7 } }, { autoStart: false, id: () => 'external' })
    await service.task_submit({ idempotencyKey: 'e', input: null })
    const [a, b] = await Promise.all([service.execute('external'), service.execute('external')])
    expect([a.status, b.status]).toContain('succeeded')
    expect(calls).toBe(1)
  })
})
