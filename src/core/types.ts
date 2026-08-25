export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface JsonSchema { [key: string]: JsonValue | undefined; type?: JsonValue; properties?: JsonValue; required?: JsonValue }
export interface MeshInfo { connected_peers?: number | string[]; dht_size?: number; router_peer_id?: string; local_api_socket?: string; [key: string]: unknown }
export interface SamService { name: string; type: string; [key: string]: unknown }
export interface RemoteService extends SamService { peer_id?: string; local_proxy_url?: string }
export interface ServiceFilter { type?: string; name?: string }
export interface ToolFilter { service_name?: string; peer_id?: string; intent?: string; tool_name?: string }
export interface RemoteTool { name?: string; tool_name?: string; service_name?: string; peer_id?: string; description?: string; inputSchema?: JsonSchema; input_schema?: JsonSchema; [key: string]: unknown }
export interface DescribeRemoteToolRequest { peer_id: string; tool_name: string }
export interface CallRemoteToolRequest extends DescribeRemoteToolRequest { arguments?: Record<string, unknown>; required_labels?: string }
export interface McpContent { type: string; text?: string; [key: string]: unknown }
export interface McpToolResult { content?: McpContent[]; structuredContent?: unknown; isError?: boolean; [key: string]: unknown }
export interface Model { id: string; object?: string; owned_by?: string; created?: number; [key: string]: unknown }
export interface ModelList { object?: string; data: Model[] }
export interface ChatMessage { role: string; content: unknown; name?: string; tool_call_id?: string; [key: string]: unknown }
export interface ChatCompletionRequest { model: string; messages: ChatMessage[]; stream?: boolean; [key: string]: unknown }
export interface ChatCompletionChoice { index: number; message?: ChatMessage; delta?: Partial<ChatMessage>; finish_reason?: string | null; [key: string]: unknown }
export interface ChatCompletionResponse { id: string; object: string; created?: number; model?: string; choices: ChatCompletionChoice[]; usage?: Record<string, number>; [key: string]: unknown }
export type SamHeaders = Headers | Record<string, string> | Array<[string, string]>;
export interface SamClientOptions { socketPath?: string | false; baseUrl?: string; tcpUrl?: string; nodeToken?: string; apiToken?: string; preferSocket?: boolean; timeoutMs?: number }
export interface SamRequestOptions { method?: string; body?: unknown; serviceHeaders?: SamHeaders; headers?: SamHeaders; signal?: AbortSignal }
export interface ChatRequestOptions { requiredLabels?: string | string[]; serviceHeaders?: SamHeaders; signal?: AbortSignal }
export interface SamRawResponse { status: number; statusText: string; headers: Headers; body: AsyncIterable<Uint8Array> }
