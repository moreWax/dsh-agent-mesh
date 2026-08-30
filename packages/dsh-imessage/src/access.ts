/**
 * Access control for iMessage: the allowlist model from the Anthropic plugin
 * (default-deny, self-chat bypass) over our JsonFileView mtime-cached reads.
 * Handles are phone numbers (+1555…) or Apple ID emails. A message is
 * allowed when its chat is a SELF-CHAT (texting yourself) or when the sender
 * (or any participant) is allowlisted.
 */
export interface AccessFile {
  /** Handle addresses allowed to reach the agent. */
  allow: string[]
}

export function isSelfChat(sender: string, participants: string[], ownHandles: string[]): boolean {
  // Self-chat = the chat with YOURSELF: every participant is an own handle
  // (or the list is empty). A 1:1 DM with a friend is NOT self-chat — it
  // must pass the allowlist, or every DM would bypass access control.
  if (participants.length === 0) return true
  return participants.every(p => ownHandles.includes(p.trim().toLowerCase()))
}

export function isAllowed(
  message: { sender: string; isFromMe: boolean; participants: string[] },
  access: AccessFile,
  ownHandles: string[],
): boolean {
  if (message.isFromMe) return true
  if (isSelfChat(message.sender, message.participants, ownHandles)) return true
  const allow = new Set(access.allow.map(h => h.trim().toLowerCase()))
  if (allow.has(message.sender.trim().toLowerCase())) return true
  return message.participants.some(p => allow.has(p.trim().toLowerCase()))
}

export function defaultAccess(): AccessFile {
  return { allow: [] }
}
