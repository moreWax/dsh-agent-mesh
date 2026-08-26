/**
 * Pure decision + formatting helpers for the self-contained node onboarding
 * flow (join = maybe-install -> enroll -> maybe-start) and for hub operators
 * minting bootstrap tokens. No I/O here: the CLI owns prompts and processes,
 * these own the decisions and the paste-ready output.
 */

export interface JoinPrerequisites { installed: boolean; enrolled: boolean }

export type JoinStep =
  | { action: 'install-offer' }
  | { action: 'already-enrolled'; dataDir?: string }
  | { action: 'join' }

/**
 * The gate order for `node join`. Interactive terminals get an install offer;
 * non-interactive contexts (CI, scripts) get an instruction instead of a
 * surprise network fetch — same decision, different presentation upstream.
 */
export function nextJoinStep(status: JoinPrerequisites, interactive: boolean): JoinStep {
  if (!status.installed) return { action: 'install-offer' }
  if (status.enrolled) return { action: 'already-enrolled' }
  void interactive
  return { action: 'join' }
}

/** What the CLI tells a non-interactive caller when sam-node is missing. */
export const INSTALL_INSTRUCTION =
  'sam-node is not installed. Run: npx @morewax/sam-mesh node install'

/** The official installer this kit delegates to — we do not redistribute binaries. */
export const SAM_INSTALL_CMD = 'curl -sL https://sam-mesh.dev/install.sh | bash'

/**
 * The operator-facing paste block for a freshly minted bootstrap token: store
 * the secret as a 0600 file, then run one command against the same hub.
 */
export function formatMintBlock(token: string, controlPlane: string): string {
  return [
    '# on the joining machine:',
    `printf '%s' '${token}' > ~/sam-join-token && chmod 600 ~/sam-join-token`,
    '',
    `npx @morewax/sam-mesh node join --control-plane ${controlPlane} \\`,
    '  --bootstrap-token-path ~/sam-join-token',
    '',
  ].join('\n')
}
