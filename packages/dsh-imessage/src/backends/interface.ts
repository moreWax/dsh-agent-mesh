/** Stable contract shared by the native macOS and Matrix bridge backends. */
export type IMessageBackendKind = 'native' | 'matrix'
export type IMessageBackendState =
  | 'ready' | 'needs_setup' | 'needs_permission' | 'needs_hardware_key'
  | 'needs_matrix_config' | 'needs_apple_auth' | 'degraded' | 'unavailable'

export interface IMessageBackendStatus {
  kind: IMessageBackendKind
  state: IMessageBackendState
  detail?: string
  fix?: string
  retryable: boolean
  lastHealthyAt?: string
}

export interface IMessageAttachment {
  name?: string
  path?: string
  uri?: string
  mimeType?: string
  size?: number
}

export interface IMessageAttribution {
  backend: IMessageBackendKind
  backendMessageId: string
  backendSender?: string
  matrixRoomId?: string
  matrixSender?: string
  imessageHandle?: string
}

/** Backend-neutral message. Compatibility aliases remain during the v1 migration. */
export interface IMessageBackendMessage {
  id: string
  backend: IMessageBackendKind
  conversationId: string
  sender: string
  direction: 'inbound' | 'outbound'
  timestamp: string
  text: string | null
  attachments: IMessageAttachment[]
  attribution: IMessageAttribution

  /** @deprecated compatibility aliases */
  rowid: number
  isFromMe: boolean
  date: number
  chatGuid: string
  chatId: number
  chatTitle: string | null
  participants: string[]
  attachmentPath?: string
}

export interface SendRequest { conversationId: string; text: string; files?: string[] }
export interface SendResult { ok: boolean; messageId?: string; chunks?: number }
export interface ReadRequest { conversationId?: string; limit?: number }
export interface SearchRequest { query: string; limit?: number }

export interface IMessageBackend {
  readonly kind: IMessageBackendKind
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<IMessageBackendStatus>
  send(request: SendRequest): Promise<SendResult>
  read(request: ReadRequest): Promise<IMessageBackendMessage[]>
  search(request: SearchRequest): Promise<IMessageBackendMessage[]>
}
