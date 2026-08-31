export type RuntimeErrorCode =
  | 'IMESSAGE_RUNTIME_NOT_CONFIGURED' | 'IMESSAGE_RUNTIME_UNAVAILABLE'
  | 'IMESSAGE_RUNTIME_PERMISSION_DENIED' | 'IMESSAGE_RUNTIME_INVALID_BUNDLE'
  | 'IMESSAGE_RUNTIME_UNSUPPORTED' | 'IMESSAGE_RUNTIME_TRANSIENT'

export class RuntimeError extends Error {
  readonly name = 'RuntimeError'
  constructor(readonly code: RuntimeErrorCode, message: string, readonly fix?: string, readonly retryable = false, options?: { cause?: unknown }) { super(message, options) }
  toJSON(): Record<string, unknown> { return { code: this.code, message: this.message, ...(this.fix ? { fix: this.fix } : {}), retryable: this.retryable } }
}

export function safeRuntimeDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return 'Required executable was not found'
  if (code === 'EACCES') return 'Required executable is not runnable'
  if ((error as { name?: string })?.name === 'AbortError') return 'Operation cancelled'
  return 'Runtime operation failed; inspect the private runtime logs for details'
}
