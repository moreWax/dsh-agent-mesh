import { describe, expect, it } from 'vitest'
import type { IMessageBackendMessage } from '../src/backends/interface.js'

function message(backend: 'native' | 'matrix'): IMessageBackendMessage {
  return { id: `${backend}:1`, backend, conversationId: 'conversation', sender: 'friend', direction: 'inbound', timestamp: new Date(0).toISOString(), text: 'hello', attachments: [], attribution: { backend, backendMessageId: '1' }, rowid: 1, isFromMe: false, date: 0, chatGuid: 'conversation', chatId: 1, chatTitle: null, participants: ['friend'] }
}

describe('backend-neutral attribution', () => {
  it('requires equivalent identity, direction and backend attribution', () => {
    for (const backend of ['native', 'matrix'] as const) {
      const value = message(backend)
      expect(value.attribution.backend).toBe(backend)
      expect(value.conversationId).toBe(value.chatGuid)
      expect(value.direction).toBe('inbound')
      expect(value.timestamp).toMatch(/Z$/)
    }
  })
})
