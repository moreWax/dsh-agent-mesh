import { describe, expect, it, vi } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import { AgentMeshWebHost } from "../src/web/host.js"
import type { ActionResult, EnrollmentSession, NodeStatus } from "@morewax/sam-mesh/node"

/** A fake manager with the lifecycle surface the host uses. */
function fakeManager(status: Partial<NodeStatus>, startResult: ActionResult = { ok: true, message: "sam-node started" }) {
  const base: NodeStatus = {
    installed: true, binaryPath: "/usr/bin/sam-node", enrolled: true, enrolledHub: "https://hub.sam-mesh.dev", running: false,
    pid: null, socketPath: "/tmp/sam.sock", dataDir: "/tmp/sam",
  }
  return {
    status: vi.fn(async () => ({ ...base, ...status })),
    start: vi.fn(async () => startResult),
    stop: vi.fn(async (): Promise<ActionResult> => ({ ok: true, message: "sent SIGTERM" })),
    beginEnrollment: vi.fn(() => ({ sessionId: "s1", info: () => ({}) }) as unknown as EnrollmentSession),
    enrollment: vi.fn(() => null),
    activeEnrollment: vi.fn(() => null),
    cancelEnrollment: vi.fn(() => true),
  }
}

const mesh: never = { core: {}, operator: {} } as never

describe("node lifecycle ownership (option A: dsh owns what it starts)", () => {
  it("a card-initiated start marks the node dsh-managed; an already-running node does not", async () => {
    const ownership = { startedByUs: false }
    const manager = fakeManager({ running: false })
    const host = new AgentMeshWebHost(new Context(), mesh, manager as never, ownership)
    const approval = { approved: true, approvedBy: "tester" }

    await host.startNode(approval)
    expect(ownership.startedByUs).toBe(true)
    expect((await host.nodeStatus()).managedByDsh).toBe(true)

    // A node that was already running is external: starting is a no-op that must not claim ownership.
    const ownership2 = { startedByUs: false }
    const external = fakeManager({ running: true, pid: 123 }, { ok: true, message: "sam-node already running (pid 123)" })
    const host2 = new AgentMeshWebHost(new Context(), mesh, external as never, ownership2)
    await host2.startNode(approval)
    expect(ownership2.startedByUs).toBe(false)
    expect((await host2.nodeStatus()).managedByDsh).toBe(false)
  })

  it("nodeStatus reports managedByDsh=false by default (external node)", async () => {
    const host = new AgentMeshWebHost(new Context(), mesh, fakeManager({ running: true, pid: 42 }) as never)
    const status = await host.nodeStatus()
    expect(status.managedByDsh).toBe(false)
    expect(status.running).toBe(true)
  })
})
