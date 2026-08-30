import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { isSelfChat, isAllowed, defaultAccess } from '../src/access.js'
import { fetchSince, fetchHistory, searchMessages, currentWatermark, chatParticipants } from '../src/db.js'

function fixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, is_from_me INTEGER, date INTEGER, handle_id INTEGER, service TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '+15551112222'), (2, 'friend@icloud.com'), (3, 'me@icloud.com');
    INSERT INTO chat VALUES (1, 'iMessage;-;+15551112222', NULL), (2, 'iMessage;+;group123', 'The Crew');
    INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2), (2, 3);
    INSERT INTO message VALUES (100, 'hello from friend', 0, 700000000000000000, 1, 'iMessage');
    INSERT INTO chat_message_join VALUES (1, 100);
    INSERT INTO message VALUES (101, 'reply from me', 1, 700000001000000000, 3, 'iMessage');
    INSERT INTO chat_message_join VALUES (1, 101);
    INSERT INTO message VALUES (102, 'group msg from friend2', 0, 700000002000000000, 2, 'iMessage');
    INSERT INTO chat_message_join VALUES (2, 102);
    INSERT INTO message VALUES (103, 'an sms', 0, 700000003000000000, 1, 'SMS');
    INSERT INTO chat_message_join VALUES (1, 103);
  `)
  return db
}

describe('chat.db reads', () => {
  it('watermark + fetchSince returns new messages ascending, iMessage-only by default', () => {
    const db = fixtureDb()
    expect(currentWatermark(db)).toBe(103)
    const since = fetchSince(db, 100, false)
    expect(since.map(m => m.rowid)).toEqual([101, 102])
    expect(fetchSince(db, 100, true).map(m => m.rowid)).toEqual([101, 102, 103])
    db.close()
  })
  it('history threads come oldest-first with sender/me and chat labels', () => {
    const db = fixtureDb()
    const history = fetchHistory(db, { chatGuid: 'iMessage;-;+15551112222' })
    expect(history.map(m => m.rowid)).toEqual([100, 101])
    expect(history[0]).toMatchObject({ sender: '+15551112222', isFromMe: false, chatGuid: 'iMessage;-;+15551112222' })
    expect(history[1]).toMatchObject({ sender: 'me', isFromMe: true })
    expect(fetchHistory(db, { chatGuid: 'iMessage;-;+15551112222', allowSms: true }).map(m => m.rowid)).toEqual([100, 101, 103])
    db.close()
  })
  it('search matches text and respects the SMS default', () => {
    const db = fixtureDb()
    expect(searchMessages(db, 'hello').map(m => m.rowid)).toEqual([100])
    expect(searchMessages(db, 'sms', 25, false)).toEqual([])
    expect(searchMessages(db, 'sms', 25, true).map(m => m.rowid)).toEqual([103])
    db.close()
  })
  it('participants map joins handles per chat', () => {
    const db = fixtureDb()
    const map = chatParticipants(db, [1, 2])
    expect(map.get(1)).toEqual(['+15551112222'])
    expect(map.get(2)?.sort()).toEqual(['+15551112222', 'friend@icloud.com', 'me@icloud.com'].sort())
    db.close()
  })
})

describe('access control', () => {
  const own = ['me@icloud.com']
  it('self-chat bypasses the allowlist', () => {
    expect(isSelfChat('+15551112222', [], own)).toBe(true) // empty participant list = self-chat
    expect(isSelfChat('me', ['me@icloud.com'], own)).toBe(true) // every participant is me
    expect(isSelfChat('+15551112222', ['+15551112222'], own)).toBe(false) // a 1:1 DM with a friend is NOT self-chat (needs the allowlist)
    expect(isSelfChat('+15551112222', ['+15551112222', 'friend@icloud.com'], own)).toBe(false) // a third party
  })
  it('default-deny; allowlist by sender or any participant; outbound always allowed', () => {
    const access = defaultAccess()
    expect(isAllowed({ sender: '+15551112222', isFromMe: false, participants: ['+15551112222', 'friend@icloud.com'] }, access, own)).toBe(false)
    const open = { allow: ['friend@icloud.com'] }
    expect(isAllowed({ sender: '+15551112222', isFromMe: false, participants: ['+15551112222', 'friend@icloud.com'] }, open, own)).toBe(true)
    expect(isAllowed({ sender: 'me', isFromMe: true, participants: [] }, access, own)).toBe(true)
    // case-insensitive handles
    expect(isAllowed({ sender: 'FRIEND@ICLOUD.COM', isFromMe: false, participants: [] }, open, own)).toBe(true)
  })
})
