import { describe, expect, it } from 'vitest'
import { InMemoryTaskStore, TaskService } from '../src/tasks/service.js'
import { SQLiteTaskStore } from '../src/tasks/sqlite.js'
import { TaskHttpServer } from '../src/tasks/http.js'

import type { TaskExecutor } from '../src/tasks/service.js'
const executor: TaskExecutor = { async execute(task) { return task.input ?? null } }

async function call(url: string, args: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_submit', arguments: { idempotencyKey: `k-${Math.random()}`, input: {}, ...args } } }),
  })
  return (await res.json()) as { result?: { structuredContent?: { task?: { taskId?: string } } }; error?: { code: number; message: string } }
}

describe('task service capability gate (public-hub posture)', () => {
  it('rejects calls without a capability, accepts with it, and the rejection is uniform', async () => {
    const service = new TaskService(new InMemoryTaskStore(), executor)
    const server = new TaskHttpServer(service, { capability: 'fleet-secret-123' })
    const address = await server.start()
    try {
      const missing = await call(address.mcpUrl, {})
      const wrong = await call(address.mcpUrl, { _capability: 'nope' })
      expect(missing.error?.message).toBe(wrong.error?.message)
      expect(wrong.error?.message).toContain('fleet capability required') // no oracle: identical to missing
      const right = await call(address.mcpUrl, { _capability: 'fleet-secret-123' })
      expect(right.error).toBeUndefined()
      expect(right.result?.structuredContent?.task?.taskId).toBeTruthy()
    } finally { await server.stop() }
  })

  it('strips _capability before schema validation (additionalProperties: false)', async () => {
    const service = new TaskService(new InMemoryTaskStore(), executor)
    const server = new TaskHttpServer(service, { capability: 's' })
    const address = await server.start()
    try {
      const res = await call(address.mcpUrl, { _capability: 's' })
      expect(res.error).toBeUndefined() // would be TASK_VALIDATION if the field leaked through
    } finally { await server.stop() }
  })

  it('no capability configured = open service (private-hub posture unchanged)', async () => {
    const service = new TaskService(new InMemoryTaskStore(), executor)
    const server = new TaskHttpServer(service, {})
    const address = await server.start()
    try {
      const res = await call(address.mcpUrl, {})
      expect(res.result?.structuredContent?.task?.taskId).toBeTruthy()
    } finally { await server.stop() }
  })

  it('tools/list and initialize stay reachable — the gate protects execution, not existence', async () => {
    const service = new TaskService(new InMemoryTaskStore(), executor)
    const server = new TaskHttpServer(service, { capability: 's' })
    const address = await server.start()
    try {
      const res = await fetch(address.mcpUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
      })
      const body = (await res.json()) as { result?: { tools?: unknown[] } }
      expect(body.result?.tools?.length).toBeGreaterThan(0)
    } finally { await server.stop() }
  })
})
