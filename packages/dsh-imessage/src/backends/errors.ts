export const IMESSAGE_ERROR_CODES = [
  'IMESSAGE_NOT_CONFIGURED', 'IMESSAGE_BACKEND_UNAVAILABLE', 'IMESSAGE_PERMISSION_REQUIRED',
  'IMESSAGE_HARDWARE_KEY_REQUIRED', 'IMESSAGE_MATRIX_UNAVAILABLE', 'IMESSAGE_BRIDGE_UNAVAILABLE',
  'IMESSAGE_APPLE_AUTH_REQUIRED', 'IMESSAGE_ACCESS_DENIED', 'IMESSAGE_TARGET_NOT_FOUND',
  'IMESSAGE_RATE_LIMITED', 'IMESSAGE_TRANSIENT',
] as const

export type IMessageErrorCode = typeof IMESSAGE_ERROR_CODES[number]

export interface IMessageErrorOptions {
  detail?: string
  fix?: string
  retryable?: boolean
  cause?: unknown
}

/** A public, secret-safe backend failure. `cause` is deliberately not serialized. */
export class IMessageError extends Error {
  readonly name = 'IMessageError'
  readonly code: IMessageErrorCode
  readonly detail: string | undefined
  readonly fix: string | undefined
  readonly retryable: boolean

  constructor(code: IMessageErrorCode, message: string, options: IMessageErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.code = code
    this.detail = options.detail
    this.fix = options.fix
    this.retryable = options.retryable ?? false
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}), ...(this.fix ? { fix: this.fix } : {}), retryable: this.retryable }
  }
}

const SECRET_PATTERNS = [
  /authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi,
  /(?:access[_-]?token|password|authorization|capability|hardware[_-]?key|fairplay)\s*[:=]\s*[^\s,;]+/gi,
  /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
  /(?:syt_|MDAx|eyJ)[A-Za-z0-9._~-]{12,}/g,
]

export function redactSensitive(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value)
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]')
  return text.slice(0, 500)
}

export function publicError(error: unknown): IMessageError {
  if (error instanceof IMessageError) return error
  return new IMessageError('IMESSAGE_TRANSIENT', 'The iMessage operation failed', {
    detail: redactSensitive(error), retryable: true, cause: error,
  })
}
