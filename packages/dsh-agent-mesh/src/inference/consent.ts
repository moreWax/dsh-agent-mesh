import type { AuditSink } from '../observability/index.js'

export interface InferenceApproval {
  approved: true
  approvedBy: string
  approvedAt?: string
  reason?: string
}
export interface InferenceConsentRequest {
  correlationId: string
  provider: string
  model?: string
  route: 'pinned'
  sensitivity: 'sensitive'
}
export type InferenceConsent = (request: Readonly<InferenceConsentRequest>) => boolean | InferenceApproval | Promise<boolean | InferenceApproval>

export class InferenceConsentError extends Error {
  readonly code = 'SAM_INFERENCE_CONSENT_REQUIRED'
  constructor(message: string) { super(message); this.name = 'InferenceConsentError' }
}

export async function approveSensitivePinned(input: InferenceConsentRequest, consent: InferenceConsent | undefined): Promise<InferenceApproval> {
  if (!input.provider.trim()) throw new InferenceConsentError('Sensitive pinned inference requires provider attribution')
  if (!consent) throw new InferenceConsentError('Sensitive pinned inference requires explicit approval')
  const decision = await consent(Object.freeze({ ...input }))
  if (decision === true) return { approved: true, approvedBy: 'consent-callback' }
  if (!decision || decision.approved !== true || !decision.approvedBy.trim()) throw new InferenceConsentError('Sensitive pinned inference was not approved')
  return decision
}
export type { AuditSink }
