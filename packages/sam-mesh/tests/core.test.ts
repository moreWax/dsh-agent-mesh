import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { SamClient, SamConfigurationError, SamHttpError } from "../src/core/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
async function server(handler: http.RequestListener, socket = false) {
  const dir = await mkdtemp(join(tmpdir(), "sam-core-")); const sock = join(dir, "sam.sock");
  const srv = http.createServer(handler); if (socket) srv.listen(sock); else srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  cleanup.push(async () => { await new Promise<void>((r) => srv.close(() => r())); await rm(dir, { recursive: true }); });
  const address = srv.address(); return { sock, url: typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "" };
}
function json(res: http.ServerResponse, value: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }

describe("SamClient transport", () => {
  it("prefers Unix socket, sends no node credential, and ignores absolute host", async () => {
    const seen: http.IncomingMessage[] = []; const unix = await server((req, res) => { seen.push(req); json(res, { ok: true }); }, true);
    const tcp = await server((_req, res) => json(res, { tcp: true }));
    expect(await new SamClient({ socketPath: unix.sock, baseUrl: tcp.url, nodeToken: "secret" }).request("http://invalid.example/x?q=1")).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("/x?q=1"); expect(seen[0]?.headers["x-sam-authentication"]).toBeUndefined();
  });
  it("falls back to TCP and strictly separates node and upstream credentials", async () => {
    let headers: http.IncomingHttpHeaders = {}; const tcp = await server((req, res) => { headers = req.headers; json(res, { ok: true }); });
    await new SamClient({ socketPath: "/missing/sam.sock", baseUrl: tcp.url, nodeToken: "node" }).request("/v1/models", { headers: { Authorization: "Bearer upstream" } });
    expect(headers.authorization).toBe("Bearer upstream"); expect(headers["x-sam-authentication"]).toBe("Bearer node");
  });
  it("resolves a rotating credential lazily, only for TCP fallback", async () => {
    let token = "first"; let resolutions = 0; const seen: Array<string | undefined> = [];
    const unix = await server((_req, res) => json(res, { local: true }), true);
    const tcp = await server((req, res) => { seen.push(req.headers["x-sam-authentication"] as string | undefined); json(res, { tcp: true }); });
    const local = new SamClient({ socketPath: unix.sock, baseUrl: tcp.url, resolveNodeToken: async () => { resolutions++; return token; } });
    await local.request("/x"); expect(resolutions).toBe(0);
    const fallback = new SamClient({ socketPath: "/missing/sam.sock", baseUrl: tcp.url, resolveNodeToken: async () => { resolutions++; return token; } });
    await fallback.request("/x"); token = "second"; await fallback.request("/x");
    expect(resolutions).toBe(2); expect(seen).toEqual(["Bearer first", "Bearer second"]);
  });
  it("keeps explicit upstream Authorization separate from node authentication", async () => {
    let headers: http.IncomingHttpHeaders = {}; const tcp = await server((req, res) => { headers = req.headers; json(res, {}); });
    await new SamClient({ socketPath: false, baseUrl: tcp.url, resolveNodeToken: async () => "node" }).request("/x", { upstreamAuthorization: "Bearer service" });
    expect(headers.authorization).toBe("Bearer service"); expect(headers["x-sam-authentication"]).toBe("Bearer node");
  });
  it("rejects attempts to smuggle the node credential through service headers", async () => {
    await expect(new SamClient({ socketPath: false }).request("/x", { headers: { "X-Sam-Authentication": "bad" } })).rejects.toBeInstanceOf(SamConfigurationError);
  });
  it("returns typed HTTP errors", async () => {
    const tcp = await server((_req, res) => json(res, { error: "nope" }, 503));
    await expect(new SamClient({ socketPath: false, baseUrl: tcp.url }).request("/x")).rejects.toMatchObject({ status: 503, body: { error: "nope" } });
  });
});

describe("SAM operations", () => {
  it("initializes MCP, probes mesh info, and reuses the session", async () => {
    const methods: string[] = [];
    const unix = await server(async (req, res) => { let data=""; for await (const c of req) data += c; const rpc=JSON.parse(data); methods.push(rpc.method);
      if (rpc.method === "initialize") { res.setHeader("Mcp-Session-Id", "session"); json(res, { jsonrpc:"2.0", id:1, result:{} }); }
      else if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); }
      else json(res, { jsonrpc:"2.0", id:rpc.id, result:{ content:[{type:"text",text:JSON.stringify({local_api_socket:unix.sock,dht_size:2})}] } });
    }, true);
    const client = new SamClient({ socketPath: unix.sock });
    expect(await client.getMeshInfo()).toMatchObject({ dht_size: 2 }); await client.getMeshInfo();
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  });
  it("implements model operations and label headers", async () => {
    const calls: Array<{url?:string; labels?:string}> = []; const tcp = await server((req,res)=>{ calls.push({...(req.url ? { url:req.url } : {}),...(typeof req.headers["x-sam-required-labels"] === "string" ? { labels:req.headers["x-sam-required-labels"] } : {})}); json(res, req.url === "/v1/models" ? {data:[{id:"m"}]} : {id:"c",object:"chat.completion",choices:[]}); });
    const client = new SamClient({ socketPath:false,baseUrl:tcp.url}); expect((await client.listModels()).data[0]?.id).toBe("m");
    await client.chatCompletions({model:"m",messages:[]},{requiredLabels:["region=eu","tier=trusted"]}); expect(calls[1]?.labels).toBe("region=eu,tier=trusted");
  });
});
