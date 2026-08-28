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
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client"
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


/** Steering via the agent-mesh remote namespace — a cordis service, NOT an
 * import of @morewax/dsh-agent-mesh (the boundary holds: namespaces are the
 * cross-plugin seam). */
interface SteerFace {
  inferenceSteerStatus(q: { row?: string; serviceName?: string; peerId?: string }): Promise<{ ok: boolean; rows?: Record<string, { systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number }>; error?: string }>
  inferenceSteerApply(q: { row?: string; systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number; clear?: boolean; serviceName?: string; peerId?: string }, a: { approved: boolean; approvedBy?: string }): Promise<{ ok: boolean; message?: string; error?: string }>
}

/** Compact live-steering strip for the conversation composer dock: pick a
 * served row, nudge temperature/system prompt, apply — the NEXT model request
 * through the gate picks it up. Operator-gated service-side. */
function SteerDock({ steer }: { steer: SteerFace }) {
  const [status, setStatus] = useState<{ ok: boolean; rows?: Record<string, { systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number }> }>()
  const [row, setRow] = useState("")
  const [temperature, setTemperature] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [note, setNote] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    const poll = async () => { try { const r = await steer.inferenceSteerStatus({}); if (live) setStatus(r) } catch { /* next tick */ } }
    void poll()
    const t = setInterval(() => void poll(), 15_000)
    return () => { live = false; clearInterval(t) }
  }, [steer])
  const rows = Object.keys(status?.rows ?? {})
  if (rows.length === 0) return null
  const current = status?.rows?.[row || rows[0]!] ?? {}
  const act = async () => {
    const r = await steer.inferenceSteerApply({ row: row || rows[0]!, ...(systemPrompt ? { systemPrompt } : {}), ...(temperature !== "" ? { temperature: Number(temperature) } : {}) }, { approved: true, approvedBy: "DeepSeek Harness web user" })
    setNote(r.ok ? "steering live" : (r.error ?? "failed"))
  }
  if (!open) {
    return <button style={button} title="live model steering (operator)" onClick={() => setOpen(true)}>⚙ steer{current.temperature !== undefined || current.systemPrompt ? " ●" : ""}</button>
  }
  return <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <strong style={{ fontSize: 13 }}>⚙ steer</strong>
    <select style={{ padding: "3px 6px", borderRadius: 6 }} value={row || rows[0]} onChange={e => setRow(e.target.value)}>{rows.map(r => <option key={r} value={r}>{r}</option>)}</select>
    <input style={{ ...input, width: 64 }} placeholder={current.temperature !== undefined ? String(current.temperature) : "temp"} value={temperature} onChange={e => setTemperature(e.target.value)} />
    <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder={current.systemPrompt ? `system: ${current.systemPrompt.slice(0, 40)}…` : "system prompt…"} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
    <button style={button} onClick={() => void act()}>Apply</button>
    <button style={button} onClick={() => void steer.inferenceSteerApply({ row: row || rows[0]!, clear: true }, { approved: true, approvedBy: "DeepSeek Harness web user" }).then(() => setNote("cleared"))}>Clear</button>
    <button style={button} onClick={() => setOpen(false)}>×</button>
    {note && <small role="status">{note}</small>}
  </div>
}

/** Process-local bridge: the plugin mount subscribes to the host event once;
 * the live section's poll hooks in (and out) on mount/unmount. */
const refreshHandle: { subscribe: (() => void) | null } = { subscribe: null }

function ChatSection({ api, steer }: { api: ChatApi; steer?: SteerFace | undefined }) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [tab, setTab] = useState<"fleet" | "dm">("fleet")
  const [text, setText] = useState("")
  const [peer, setPeer] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const cursorRef = useRef(0)

  const [loadError, setLoadError] = useState("")
  useEffect(() => {
    let live = true
    const poll = async () => {
      try {
        const next = await api.chatSnapshot(cursorRef.current)
        if (!live) return
        setSnapshot(next)
        setLoadError("")
        if (next.fleet.available && next.fleet.cursor > 0) cursorRef.current = next.fleet.cursor
      } catch (error) {
        // Never hang silently: the wire failure IS the diagnosis (row failed to
        // boot, remote unbound, gateway error) — surface it.
        if (live) setLoadError(error instanceof Error ? error.message : String(error))
      }
    }
    void poll()
    // Slow fallback; the live path is the mesh-chat/updated host event
    // (subscribed by the plugin mount below) → refresh within ~2s of arrival.
    const t = setInterval(() => void poll(), 15_000)
    const onEvent = (): void => { void poll() }
    refreshHandle.subscribe = onEvent
    return () => { live = false; clearInterval(t); refreshHandle.subscribe = null }
  }, [api])

  if (!snapshot) return <section style={box}><strong>Mesh chat</strong>{loadError
    ? <p role="alert" style={{ margin: 0 }}>chat service unreachable: {loadError}</p>
    : <small>loading…</small>}</section>

  const send = async (fn: () => Promise<ActionResult>) => {
    if (busy) return
    setBusy(true); setNote("")
    try { const r = await fn(); setNote(r.ok ? (r.message ?? "sent") : (r.error ?? "failed")) } catch (e) { setNote(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const messages = tab === "fleet" ? snapshot.fleet.messages : snapshot.inbox.messages
  return <section style={box} data-testid="mesh-chat">
    <strong>Mesh chat</strong>
    {steer && <SteerDock steer={steer} />}
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
  const ui = ctx.plugin({ name: "agent-mesh-chat-ui", inject: ["slots", "remote", "remote.agentMeshChatWeb", "remote.agentMeshWeb", "settingsScope"], apply: (uiCtx: Context) => {
    const api = createChatApi(uiCtx)
    ;(uiCtx as unknown as { remote: { $on?(event: string, cb: () => void): unknown } }).remote.$on?.('mesh-chat/updated', () => refreshHandle.subscribe?.())
    const steer = ((uiCtx as unknown as { remote: Record<string, unknown> }).remote as unknown as { agentMeshWeb?: SteerFace }).agentMeshWeb
    uiCtx.slots.inject("settings.section", () => uiCtx.slots.register({ name: "settings.section", id: "mesh-chat", order: 71, label: "Mesh chat" }, () => <ChatSection api={api} {...(steer ? { steer } : {})} />))
    // Composer dock: the live-steering strip rides the agent-mesh plugin's
    // remote namespace (cordis service — zero cross-package imports).
    if (steer) {
      uiCtx.slots.inject("conversation.input.dock", () => uiCtx.slots.register({ name: "conversation.input.dock", id: "mesh-chat-steer", order: 20, inject: () => ({}) }, () => <SteerDock steer={steer} />))
    }
  } })
  return async () => { await ui.dispose(); await dispose() }
}
