/**
 * Outbound iMessage via AppleScript → Messages.app (the Anthropic plugin's
 * mechanism). Text and chat GUID pass through argv — no escaping footgun.
 * Sends are chunked (iMessage practical limit) and files go as separate
 * messages after the text.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CHUNK = 1500

export interface SendResult { ok: boolean; chunks: number; error?: string }

function script(chatGuid: string, text: string): string {
  // argv-carried values never interpolate into the script body.
  return `on run argv
  set theGuid to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    set theChat to first chat whose guid is theGuid
    send theText to theChat
  end tell
end run`
}

export async function sendIMessage(chatGuid: string, text: string, files: string[] = []): Promise<SendResult> {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK))
  if (chunks.length === 0) chunks.push(text)
  try {
    for (const chunk of chunks) {
      await execFileAsync('osascript', ['-e', script(chatGuid, chunk), chatGuid, chunk], { timeout: 15_000 })
    }
    // Attachments ride as separate messages after the text (Apple's behavior).
    for (const file of files) {
      await execFileAsync('osascript', ['-e', `on run argv
  set theGuid to item 1 of argv
  set theFile to POSIX file (item 2 of argv)
  tell application "Messages"
    set theChat to first chat whose guid is theGuid
    send theFile to theChat
  end tell
end run`, chatGuid, file], { timeout: 20_000 })
    }
    return { ok: true, chunks: chunks.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The two honest failure modes, named with their fixes.
    if (/not authorized|not permitted|1743/i.test(message)) return { ok: false, chunks: 0, error: "macOS Automation permission missing — System Settings → Privacy & Security → Automation → allow your terminal to control Messages" }
    return { ok: false, chunks: 0, error: message.slice(0, 300) }
  }
}

/** Resolve a chat GUID for a handle (phone number or Apple ID email), creating nothing. */
export async function chatGuidForHandle(handle: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('osascript', ['-e', `on run argv
  set theHandle to item 1 of argv
  tell application "Messages"
    if (count of chats) > 0 then
      repeat with theChat in chats
        repeat with theParticipant in (participants of theChat)
          if id of theParticipant is theHandle then return guid of theChat
        end repeat
      end repeat
    end if
  end tell
end run`, handle], { timeout: 15_000 })
    const guid = String(result.stdout).trim()
    return guid || undefined
  } catch { return undefined }
}
