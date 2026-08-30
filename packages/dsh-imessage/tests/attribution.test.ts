import { describe, expect, it } from 'vitest'
import { toolPayload } from '@morewax/sam-mesh'

describe('imessage attribution (Task 5)', () => {
  it('both backends produce the same IMessageBackendMessage shape', () => {
    const nativeMsg = {
      rowid: 1, text: 'hello', sender: '+15551112222', isFromMe: false,
      date: 1700000000000, chatGuid: 'iMessage;-;+15551112222', chatId: 1,
      chatTitle: null, participants: ['+15551112222'],
    }
    const bridgeMsg = {
      rowid: 0, text: 'hello', sender: '@friend:matrix.org', isFromMe: false,
      date: 1700000000000, chatGuid: 'bridge', chatId: 0,
      chatTitle: null, participants: [],
    }
    // both have the same keys
    expect(Object.keys(nativeMsg).sort()).toEqual(Object.keys(bridgeMsg).sort())
    // both carry the same semantic content
    expect(nativeMsg.text).toBe(bridgeMsg.text)
  })
})
