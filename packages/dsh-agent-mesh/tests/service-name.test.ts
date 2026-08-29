import { describe, expect, it } from 'vitest'
import { reconcileServiceName } from '../src/tasks/service-name.js'

describe('reconcileServiceName (B2)', () => {
  it('renames when the configured name is already announced remotely (consumer replica)', () => {
    expect(reconcileServiceName('morewax-dsh-task-service', ['morewax-dsh-task-service', 'dsh-chat-inbox']))
      .toEqual({ name: 'morewax-dsh-task-service-member', renamed: true })
  })
  it('passes through when the name is free (operator: own services are never self-listed)', () => {
    expect(reconcileServiceName('morewax-dsh-task-service', ['dsh-chat-inbox']))
      .toEqual({ name: 'morewax-dsh-task-service', renamed: false })
    expect(reconcileServiceName('dsh-task-service', [])).toEqual({ name: 'dsh-task-service', renamed: false })
  })
  it('an already-suffixed member name never double-suffixes', () => {
    expect(reconcileServiceName('morewax-dsh-task-service-member', ['morewax-dsh-task-service']).renamed).toBe(false)
  })
})
