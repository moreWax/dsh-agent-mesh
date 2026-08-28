/**
 * @morewax/dsh-mesh-chat browser half: mounts the remote contribution and
 * registers the chat card as a settings section. Two views in one card —
 * the fleet channel (member-gated, with system events) and direct messages
 * (the local inbox + a send box that calls a peer's inbox through the mesh).
 */
import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-api-gateway/client"
import type {} from "@deepseek-ai/dsh-client-runtime/client"
import type {} from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-settings/client"
import React, { useEffect, useRef, useState } from "react"
import { TYPERT_REMOTE } from "../remote.js"

type ChatMessage = { id: number; kind: "user" | "system"; sender: string; text: string; ts: number; meta?: unknown }
type Snapshot = { fleet: { available: boolean; cursor: number; messages: ChatMessage[]; error?: string }; inbox: { serviceName: string; messages: ChatMessage[] } }
type ActionResult = { ok: boolean; message?: string; error?: string }

const box: React.CSSProperties = { border: "1px solid var(--border,#444)", borderRadius: 8, padding: 10, display: "grid", gap: 8 }
const button: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, cursor: "pointer" }
const input: React.CSSProperties = { padding: "6px 8px", borderRadius: 6 }
const list: React.CSSProperties = { maxHeight: 260, overflowY: "auto", display: "grid", gap: 4, padding: 4, border: "1px solid var(--border,#333)", borderRadius: 6 }

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.kind === "system") return <div style={{ opacity: 0.7 }}><small>⚙ {message.sender}: {message.text}</small></div>
  return <div><strong style={{ fontSize: 13 }}>{message.sender}</strong> <small style={{ opacity: 0.6 }}>{new Date(message.ts).toLocaleTimeString()}</small><div>{message.text}</div></div>
}

function ChatSection({ api }: { api: ChatApi }) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [tab, setTab] = useState<"fleet" | "dm">("fleet")
  const [text, setText] = useState("")
  const [peer, setPeer] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const cursorRef = useRef(0)

  useEffect(() => {
    let live = true
    const poll = async () => {
      try {
        const next = await api.chatSnapshot(cursorRef.current)
        if (!live) return
        setSnapshot(next)
        if (next.fleet.available && next.fleet.cursor > 0) cursorRef.current = next.fleet.cursor
      } catch { /* transient; the next tick retries */ }
    }
    void poll()
    const t = setInterval(() => void poll(), 3000)
    return () => { live = false; clearInterval(t) }
  }, [api])

  if (!snapshot) return <section style={box}><strong>Mesh chat</strong><small>loading…</small></section>

  const send = async (fn: () => Promise<ActionResult>) => {
    if (busy) return
    setBusy(true); setNote("")
    try { const r = await fn(); setNote(r.ok ? (r.message ?? "sent") : (r.error ?? "failed")) } catch (e) { setNote(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const messages = tab === "fleet" ? snapshot.fleet.messages : snapshot.inbox.messages
  return <section style={box} data-testid="mesh-chat">
    <strong>Mesh chat</strong>
    <div>
      <button style={{ ...button, fontWeight: tab === "fleet" ? 700 : 400 }} onClick={() => setTab("fleet")}>Fleet channel</button>{" "}
      <button style={{ ...button, fontWeight: tab === "dm" ? 700 : 400 }} onClick={() => setTab("dm")}>Direct</button>
    </div>
    {tab === "fleet" && !snapshot.fleet.available && <p role="alert" style={{ margin: 0, opacity: 0.8 }}>{snapshot.fleet.error ?? "fleet channel unavailable"}</p>}
    <div style={list}>{messages.map(m => <MessageRow key={`${m.id}-${m.ts}`} message={m} />)}{messages.length === 0 && <small style={{ opacity: 0.6 }}>no messages yet</small>}</div>
    {tab === "fleet" && <div style={{ display: "flex", gap: 6 }}>
      <input style={{ ...input, flex: 1 }} placeholder="message the fleet…" value={text} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && text.trim()) void send(async () => { const r = await api.chatSend(text); if (r.ok) setText(""); return r }) }} />
      <button style={button} disabled={busy || !text.trim()} onClick={() => void send(async () => { const r = await api.chatSend(text); if (r.ok) setText(""); return r })}>Send</button>
    </div>}
    {tab === "dm" && <div style={{ display: "grid", gap: 6 }}>
      <input style={input} placeholder="peer id (12D3Koo…)" value={peer} onChange={e => setPeer(e.target.value.trim())} />
      <div style={{ display: "flex", gap: 6 }}>
        <input style={{ ...input, flex: 1 }} placeholder="direct message…" value={text} onChange={e => setText(e.target.value)} />
        <button style={button} disabled={busy || !text.trim() || !peer} onClick={() => void send(async () => { const r = await api.dmSend(peer, text); if (r.ok) setText(""); return r })}>Send DM</button>
      </div>
      <small style={{ opacity: 0.6 }}>DMs ride the authenticated mesh transport; the peer&apos;s inbox is rate-limited.</small>
    </div>}
    {note && <small role="status">{note}</small>}
  </section>
}

export interface ChatApi { chatSnapshot(afterId?: number): Promise<Snapshot>; chatSend(text: string): Promise<ActionResult>; dmSend(peerId: string, text: string): Promise<ActionResult> }
function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T { if (!r.ok) throw new Error(r.error.message); return r.value }
export function createChatApi(ctx: Context): ChatApi {
  const r = (ctx as unknown as { remote: { agentMeshChatWeb: { chatSnapshot(a?: number): Promise<{ ok: true; value: Snapshot } | { ok: false; error: { message: string } }>; chatSend(t: string): Promise<{ ok: true; value: ActionResult } | { ok: false; error: { message: string } }>; dmSend(p: string, t: string): Promise<{ ok: true; value: ActionResult } | { ok: false; error: { message: string } }> } } }).remote.agentMeshChatWeb
  return {
    chatSnapshot: async (afterId?: number) => unwrap(await r.chatSnapshot(afterId ?? 0)),
    chatSend: async (text: string) => unwrap(await r.chatSend(text)),
    dmSend: async (peerId: string, text: string) => unwrap(await r.dmSend(peerId, text)),
  }
}

/** Same split as the agent-mesh card: the OUTER plugin mounts the contribution;
 * a child plugin injects the remote namespace and registers the UI section. */
export const name = "agent-mesh-chat-client"; export const inject = ["slots", "remote", "settingsScope"] as const
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const dispose = await ctx.remote.$mount(TYPERT_REMOTE)
  const ui = ctx.plugin({ name: "agent-mesh-chat-ui", inject: ["slots", "remote", "remote.agentMeshChatWeb", "settingsScope"], apply: (uiCtx: Context) => {
    const api = createChatApi(uiCtx)
    uiCtx.slots.inject("settings.section", () => uiCtx.slots.register({ name: "settings.section", id: "mesh-chat", order: 71, label: "Mesh chat" }, () => <ChatSection api={api} />))
  } })
  return async () => { await ui.dispose(); await dispose() }
}
