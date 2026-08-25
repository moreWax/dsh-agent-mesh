import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CallRemoteToolRequest, ChatCompletionRequest, ChatCompletionResponse, ChatRequestOptions,
  DescribeRemoteToolRequest, McpToolResult, MeshInfo, ModelList, RemoteService, RemoteTool,
  SamClientOptions, SamRawResponse, SamRequestOptions, SamService, ServiceFilter, ToolFilter,
} from "./types.js";
import { SamConfigurationError, SamFeatureUnavailableError, SamHttpError, SamProtocolError, SamRpcError, SamTransportError } from "./errors.js";

const DEFAULT_SOCKET = join(homedir(), ".config", "sam-mesh", "sam.sock");
const DEFAULT_BASE = "http://127.0.0.1:8080";
const RESERVED_NODE_HEADER = "x-sam-authentication";

function headersRecord(init?: import("./types.js").SamHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (init) for (const [key, value] of new Headers(init)) out[key] = value;
  return out;
}
function nodeHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(key, item);
    else if (value !== undefined) result.set(key, value);
  }
  return result;
}
async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of body) { chunks.push(chunk); size += chunk.byteLength; }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return all;
}

export class SamClient {
  readonly socketPath: string | false;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #nodeToken: string | undefined;
  readonly #resolveNodeToken: (() => Promise<string | undefined>) | undefined;
  #mcpSession?: string;
  #mcpInitializing: Promise<string> | undefined;

  constructor(options: SamClientOptions = {}) {
    this.socketPath = options.preferSocket === false ? false : (options.socketPath === undefined ? DEFAULT_SOCKET : options.socketPath);
    this.baseUrl = (options.baseUrl ?? options.tcpUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.#nodeToken = options.nodeToken ?? options.apiToken;
    this.#resolveNodeToken = options.resolveNodeToken;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new SamConfigurationError("timeoutMs must be positive");
    try { new URL(this.baseUrl); } catch (cause) { throw new SamConfigurationError("baseUrl must be an absolute HTTP URL", { cause }); }
  }

  async requestRaw(path: string, options: SamRequestOptions = {}): Promise<SamRawResponse> {
    const headers = { ...headersRecord(options.headers), ...headersRecord(options.serviceHeaders) };
    if (options.upstreamAuthorization !== undefined) {
      if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization"))
        throw new SamConfigurationError("Pass upstream Authorization either as upstreamAuthorization or a header, not both");
      headers.authorization = options.upstreamAuthorization;
    }
    if (Object.keys(headers).some((key) => key.toLowerCase() === RESERVED_NODE_HEADER))
      throw new SamConfigurationError("X-Sam-Authentication is reserved; pass nodeToken in SamClientOptions");
    let body: Buffer | undefined;
    if (options.body !== undefined) {
      body = Buffer.from(typeof options.body === "string" || options.body instanceof Uint8Array
        ? options.body : JSON.stringify(options.body));
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      headers["content-length"] = String(body.byteLength);
    }
    if (this.socketPath) {
      try { return await this.#dial(path, options.method ?? (body ? "POST" : "GET"), headers, body, options.signal, this.socketPath); }
      catch (cause) {
        if (!(cause instanceof SamTransportError)) throw cause;
        // An inaccessible local socket is the only condition that triggers TCP fallback.
      }
    }
    const tcpHeaders = { ...headers };
    // Credential lookup is deliberately below the socket attempt: healthy local
    // traffic neither needs nor exposes the node credential. Resolve afresh for
    // each fallback so rotations take effect without restarting Cordis.
    const nodeToken = this.#nodeToken ?? await this.#resolveNodeToken?.();
    if (nodeToken) tcpHeaders["x-sam-authentication"] = nodeToken.startsWith("Bearer ") ? nodeToken : `Bearer ${nodeToken}`;
    return this.#dial(path, options.method ?? (body ? "POST" : "GET"), tcpHeaders, body, options.signal);
  }

  async *requestStream(path: string, options: SamRequestOptions = {}): AsyncIterable<Uint8Array> {
    const response = await this.requestRaw(path, options);
    if (response.status < 200 || response.status >= 300) await this.#throwHttp(response);
    yield* response.body;
  }

  async request<T>(path: string, options: SamRequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(path, options);
    if (response.status < 200 || response.status >= 300) await this.#throwHttp(response);
    const bytes = await collect(response.body);
    if (!bytes.byteLength) return undefined as T;
    const text = new TextDecoder().decode(bytes);
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter((line) => line !== "[DONE]").at(-1)
      : text;
    try { return JSON.parse(payload ?? "") as T; }
    catch (cause) { throw new SamProtocolError("SAM returned invalid JSON", text, { cause }); }
  }

  async getMeshInfo(): Promise<MeshInfo> { return this.#tool<MeshInfo>("get_mesh_info", {}); }
  async listLocalServices(): Promise<SamService[]> { return this.#tool<SamService[]>("list_local_services", {}); }
  async discoverRemoteServices(filter: ServiceFilter = {}): Promise<RemoteService[]> { return this.#tool<RemoteService[]>("discover_remote_services", filter); }
  async findRemoteTools(filter: ToolFilter = {}, signal?: AbortSignal): Promise<RemoteTool[]> { return this.#tool<RemoteTool[]>("find_remote_tools", filter, signal); }
  async describeRemoteTool(input: DescribeRemoteToolRequest, signal?: AbortSignal): Promise<RemoteTool> { return this.#tool<RemoteTool>("describe_remote_tool", input, signal); }
  async callRemoteTool(input: CallRemoteToolRequest, signal?: AbortSignal): Promise<McpToolResult> { return this.#tool<McpToolResult>("call_remote_tool", { ...input, arguments: input.arguments ?? {} }, signal, true); }
  async probe(): Promise<MeshInfo> { return this.getMeshInfo(); }
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> { return this.#tool<T>(name, args); }
  async listModels(): Promise<ModelList> { return this.request<ModelList>("/v1/models"); }
  async chatCompletions(input: ChatCompletionRequest, options: ChatRequestOptions = {}): Promise<ChatCompletionResponse> {
    if (input.stream) throw new SamFeatureUnavailableError("streaming chatCompletions (use requestStream)");
    const labels = Array.isArray(options.requiredLabels) ? options.requiredLabels.join(",") : options.requiredLabels;
    const serviceHeaders = { ...headersRecord(options.serviceHeaders), ...(labels ? { "x-sam-required-labels": labels } : {}) };
    return this.request<ChatCompletionResponse>("/v1/chat/completions", { method: "POST", body: input, serviceHeaders, ...(options.signal ? { signal: options.signal } : {}) });
  }

  async #tool<T>(name: string, args: object, signal?: AbortSignal, preserveResult = false): Promise<T> {
    const session = await this.#ensureMcpSession();
    const envelope = await this.request<{ jsonrpc?: string; result?: McpToolResult; error?: { code: number; message: string; data?: unknown } }>("/mcp", {
      method: "POST", body: { jsonrpc: "2.0", id: `${Date.now()}-${Math.random()}`, method: "tools/call", params: { name, arguments: args } },
      serviceHeaders: { accept: "application/json, text/event-stream", "mcp-session-id": session },
      ...(signal ? { signal } : {}),
    });
    if (envelope.error) throw new SamRpcError(envelope.error.message, envelope.error.code, envelope.error.data);
    if (!envelope.result) throw new SamProtocolError(`MCP response for ${name} has no result`, envelope);
    if (envelope.result.isError) throw new SamProtocolError(`SAM tool ${name} failed`, envelope.result);
    if (preserveResult) return envelope.result as T;
    const structured = envelope.result.structuredContent;
    if (structured !== undefined) return structured as T;
    const text = envelope.result.content?.find((item) => item.type === "text")?.text;
    if (text === undefined) return envelope.result as T;
    try { return JSON.parse(text) as T; } catch { return text as T; }
  }

  async #ensureMcpSession(): Promise<string> {
    if (this.#mcpSession) return this.#mcpSession;
    if (this.#mcpInitializing) return this.#mcpInitializing;
    this.#mcpInitializing = (async () => {
      const response = await this.requestRaw("/mcp", { method: "POST", serviceHeaders: { accept: "application/json, text/event-stream" }, body: {
        jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dsh-agent-mesh", version: "0.1.0" } },
      }});
      if (response.status < 200 || response.status >= 300) await this.#throwHttp(response);
      // Consume initialization before notifying the server.
      await collect(response.body);
      const session = response.headers.get("mcp-session-id");
      if (!session) throw new SamProtocolError("MCP initialize response omitted Mcp-Session-Id");
      const initialized = await this.requestRaw("/mcp", { method: "POST", serviceHeaders: { "mcp-session-id": session, accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
      if (initialized.status < 200 || initialized.status >= 300) await this.#throwHttp(initialized);
      await collect(initialized.body);
      this.#mcpSession = session;
      return session;
    })();
    try { return await this.#mcpInitializing; } finally { this.#mcpInitializing = undefined; }
  }

  #dial(path: string, method: string, headers: Record<string, string>, body?: Buffer, signal?: AbortSignal, socketPath?: string): Promise<SamRawResponse> {
    let url: URL;
    try { url = new URL(path, `${this.baseUrl}/`); } catch (cause) { throw new SamConfigurationError(`Invalid request path: ${path}`, { cause }); }
    const options: RequestOptions = { method, headers, signal, path: `${url.pathname}${url.search}` };
    if (socketPath) options.socketPath = socketPath;
    else { options.hostname = url.hostname; options.port = url.port || 80; }
    return new Promise((resolve, reject) => {
      const req = http.request(options, (response: IncomingMessage) => resolve({
        status: response.statusCode ?? 0, statusText: response.statusMessage ?? "", headers: nodeHeaders(response.headers), body: response,
      }));
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`request timed out after ${this.timeoutMs}ms`)));
      req.once("error", (cause) => reject(new SamTransportError(`SAM ${socketPath ? "Unix socket" : "TCP"} request failed`, socketPath ? "unix" : "tcp", { cause })));
      if (body) req.write(body);
      req.end();
    });
  }
  async #throwHttp(response: SamRawResponse): Promise<never> {
    const bytes = await collect(response.body); const text = new TextDecoder().decode(bytes);
    let parsed: unknown = text; try { parsed = text ? JSON.parse(text) : undefined; } catch { /* retain text */ }
    throw new SamHttpError(`SAM HTTP ${response.status} ${response.statusText}`.trim(), response.status, response.statusText, parsed);
  }
}
export { SamClient as SAMClient };
