import { describe, expect, it, vi } from "vitest"
import { MeshOperator, parseServiceRegistrationRequest, planNodeReset, planSamNodeCommand } from "../src/operator/index.js"
import type { SamCore } from "../src/operator/index.js"

function fixture() {
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal?: AbortSignal) => ({ state: "online" }))
  const coreRequest = vi.fn(async () => ({ id: "service-1", name: "search" }))
  const core = { callTool, request: coreRequest } as unknown as SamCore
  return { operator: new MeshOperator(core), callTool, coreRequest }
}
describe("MeshOperator", () => {
  it("delegates reads to the abstract core", async () => {
    const { operator, callTool } = fixture()
    await operator.status()
    expect(callTool).toHaveBeenCalledWith("get_mesh_info", {}, undefined)
  })
  it("validates and delegates service registration", async () => {
    const { operator, coreRequest } = fixture()
    await operator.registerService({ name: "search", protocol: "mcp", endpoint: "http://127.0.0.1:9000/mcp", ignored: "x" })
    expect(coreRequest).toHaveBeenCalledWith("/sam/service/register", { method: "POST", body: { service: { name: "search", type: "mcp" }, target_url: "http://127.0.0.1:9000/mcp" }, signal: undefined })
  })
  it("builds install plans but never executes them", () => {
    const { operator, callTool } = fixture()
    const plan = operator.planSkillInstall({ source: "github:org/skill", version: "1.2.0" })
    expect(plan.command.requiresApproval).toBe(true)
    expect(plan.command.approved).toBe(false)
    expect(plan.command.args).toEqual(["skill", "install", "github:org/skill", "--version", "1.2.0"])
    expect(callTool).not.toHaveBeenCalled()
  })
})
describe("command safety", () => {
  it("requires approval for reset", () => expect(planNodeReset().approved).toBe(false))
  it("records explicit reset approval", () => expect(planNodeReset({ approved: true, approvedBy: "operator" }).approved).toBe(true))
  it("quotes display text and retains argv boundaries", () => expect(planSamNodeCommand(["logs", "two words"]).display).toBe("sam-node logs 'two words'"))
  it("rejects newline injection", () => expect(() => planSamNodeCommand(["status\nreset"])).toThrow())
})
describe("schemas", () => {
  it("rejects missing required fields", () => expect(() => parseServiceRegistrationRequest({ name: "x" })).toThrow())
  it("rejects service targets with credentials or non-HTTP schemes", () => {
    expect(() => parseServiceRegistrationRequest({ name: "x", protocol: "mcp", endpoint: "file:///etc/passwd" })).toThrow()
    expect(() => parseServiceRegistrationRequest({ name: "x", protocol: "mcp", endpoint: "http://user:pass@localhost" })).toThrow()
  })
})


describe("operator checkup and setup", () => {
  it("runs the documented SAM diagnostic tools and retains partial failures", async () => {
    const { operator, callTool } = fixture()
    callTool.mockRejectedValueOnce(new Error("node unavailable"))
    const report = await operator.checkup()
    expect(callTool.mock.calls.map((call) => call[0])).toEqual(["get_mesh_info", "get_network_info", "get_token_info", "list_local_services"])
    expect(report.healthy).toBe(false)
    expect(report.failures[0]?.message).toBe("node unavailable")
  })
  it("only plans mutating setup actions and never executes them", () => {
    const { operator, callTool, coreRequest } = fixture()
    const plan = operator.setup({ createConfig: true, startNode: true })
    expect(plan.commands.map((command) => command.args)).toEqual([["init"], ["run"]])
    expect(plan.readyToExecute).toBe(false)
    expect(callTool).not.toHaveBeenCalled()
    expect(coreRequest).not.toHaveBeenCalled()
  })
})
