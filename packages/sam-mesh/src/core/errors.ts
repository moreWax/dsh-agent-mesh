export class SamError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = new.target.name; }
}
export class SamConfigurationError extends SamError {}
export class SamTransportError extends SamError { constructor(message: string, readonly transport: "unix" | "tcp", options?: ErrorOptions) { super(message, options); } }
export class SamHttpError extends SamError {
  constructor(message: string, readonly status: number, readonly statusText: string, readonly body?: unknown) { super(message); }
}
export class SamProtocolError extends SamError { constructor(message: string, readonly payload?: unknown, options?: ErrorOptions) { super(message, options); } }
export class SamRpcError extends SamError { constructor(message: string, readonly code: number, readonly data?: unknown) { super(message); } }
export class SamFeatureUnavailableError extends SamError { constructor(readonly feature: string) { super(`SAM node does not advertise required feature: ${feature}`); } }
