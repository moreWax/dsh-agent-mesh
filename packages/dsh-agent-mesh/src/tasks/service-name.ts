/**
 * Boot-time service-name reconciliation (B2): a consumer must never shadow
 * the fleet's service name. If the configured name is already announced by a
 * remote peer, the local row registers as '<name>-member' instead — the same
 * convention fleetProfilePatch writes for new pairings, applied automatically
 * for existing profiles. Pure decision logic.
 */

/**
 * @param configured - the row's configured service name.
 * @param remoteNames - service names currently visible in REMOTE discovery (own registrations are never self-listed).
 * @returns the name to register under, and whether a rename happened.
 */
export function reconcileServiceName(configured: string, remoteNames: readonly string[]): { name: string; renamed: boolean } {
  if (remoteNames.includes(configured)) return { name: `${configured}-member`, renamed: true }
  return { name: configured, renamed: false }
}
