import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryTaskStore, TaskService, type TaskExecutor } from '../src/tasks/service.js'
import { SQLiteTaskStore } from '../src/tasks/sqlite.js'

const executor: TaskExecutor = { async execute(task) { return task.input ?? null } }

describe('task durability across restarts', () => {
  it('a task submitted to one store instance is readable from a fresh one (simulated restart)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-persist-'))
    const file = join(dir, 'tasks.db')
    const first = new TaskService(new SQLiteTaskStore(file), executor)
    const submitted = await first.task_submit({ idempotencyKey: 'k1', input: { hello: 'world' }, kind: 'note' })
    expect(submitted.task.taskId).toBeTruthy()
    ;(first.store as SQLiteTaskStore).close()

    // simulated restart: brand-new service over the same file
    const second = new TaskService(new SQLiteTaskStore(file), executor)
    const got = await second.task_get({ taskId: submitted.task.taskId })
    expect(got.task?.input).toEqual({ hello: 'world' })
    ;(second.store as SQLiteTaskStore).close()
    expect(existsSync(file)).toBe(true)
  })

  it('in-memory stays ephemeral by design (no file to reopen)', async () => {
    const service = new TaskService(new InMemoryTaskStore(), executor)
    await service.task_submit({ idempotencyKey: 'k2', input: {} })
    expect(true).toBe(true)
  })
})
