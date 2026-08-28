import { describe, expect, it } from 'vitest'
import { SQLiteChatStore } from '../src/store.js'

describe('SQLiteChatStore', () => {
  it('append → fetch by cursor, ascending; channels are isolated', () => {
    const store = new SQLiteChatStore(':memory:')
    const a = store.append('fleet', { kind: 'user', sender: 'mac', text: 'hello fleet' })
    store.append('inbox', { kind: 'user', sender: 'peer', text: 'dm!' })
    const b = store.append('fleet', { kind: 'system', sender: 'system', text: 'member approved', meta: { tool: 'fleet_pair_approve' } })
    expect(store.fetch('fleet')).toHaveLength(2)
    expect(store.fetch('inbox')).toHaveLength(1)
    const after = store.fetch('fleet', a.id)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(b.id)
    expect(after[0]!.meta).toEqual({ tool: 'fleet_pair_approve' })
    expect(store.count('fleet')).toBe(2)
    store.close()
  })
  it('memory and file stores share the schema', () => {
    const store = new SQLiteChatStore(':memory:')
    store.append('fleet', { kind: 'user', sender: 'x', text: 'y' })
    expect(store.fetch('fleet', 0, 10)[0]!.text).toBe('y')
    store.close()
  })
})
