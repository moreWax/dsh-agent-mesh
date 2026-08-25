import type { CliCommandPlan, CliRisk, CommandApproval } from "./types.js"

const SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/
function validateArg(value: string): string {
  if (!value || /[\0\r\n]/.test(value)) throw new TypeError("command arguments must be non-empty and contain no control characters")
  return value
}
function quote(value: string): string { return SAFE.test(value) ? value : `'${value.replaceAll("'", `'\"'\"'`)}'` }
export function planSamNodeCommand(args: readonly string[], risk: CliRisk = "read-only", approval?: CommandApproval): CliCommandPlan {
  if (!Array.isArray(args) || args.length === 0) throw new TypeError("at least one sam-node argument is required")
  const clean = args.map(validateArg)
  const destructive = clean.some((arg) => /^(reset|purge|delete|destroy|wipe)$/i.test(arg))
  const effectiveRisk: CliRisk = destructive ? "destructive" : risk
  const requiresApproval = effectiveRisk !== "read-only"
  const approved = requiresApproval ? approval?.approved === true && approval.approvedBy.trim() !== "" : true
  const warnings: string[] = []
  if (destructive) warnings.push("Destructive sam-node operation; explicit operator approval is required.")
  else if (requiresApproval) warnings.push("This command may mutate node state; explicit operator approval is required.")
  if (requiresApproval && !approved) warnings.push("Not approved. This plan must not be executed.")
  return Object.freeze({ executable: "sam-node", args: Object.freeze(clean), display: ["sam-node", ...clean.map(quote)].join(" "), risk: effectiveRisk, requiresApproval, approved, warnings: Object.freeze(warnings) })
}

export function planNodeStatus(): CliCommandPlan { return planSamNodeCommand(["status"]) }
export function planNodeLogs(limit = 100): CliCommandPlan {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("limit must be an integer from 1 to 10000")
  return planSamNodeCommand(["logs", "--limit", String(limit)])
}
export function planNodeReset(approval?: CommandApproval): CliCommandPlan { return planSamNodeCommand(["reset"], "destructive", approval) }
