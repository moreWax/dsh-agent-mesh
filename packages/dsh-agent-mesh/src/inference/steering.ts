/**
 * Live model steering: operator tools mounted on the fleet task service by the
 * inference row. inference_steer writes the steer file the gates merge per
 * request (defaults only — caller values win); inference_steer_status reads it.
 * Steering is operator-class: it shapes every fleet member's experience.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolDescriptor } from '../tasks/tools.js'
import { TaskProtocolError, type JsonObject } from '../tasks/types.js'

export interface SteeringDoc { systemPrompt?: string; temperature?: number; topP?: number; maxTokens?: number }

const steerError = (code: string, message: string, retryable = false): TaskProtocolError =>
  new TaskProtocolError({ code, message, retryable })

async function readSteer(path: string): Promise<SteeringDoc> {
  try { return JSON.parse(await readFile(path, 'utf8')) as SteeringDoc } catch { return {} }
}

export function steeringTools(steerFileFor: (row?: string) => { file: string; row: string }, listRows: () => string[]): ToolDescriptor[] {
  const obj = (required: string[], properties: Record<string, unknown>): Record<string, unknown> =>
    ({ type: 'object', required, properties, additionalProperties: false })
  return [
    { name: 'inference_steer', description: 'Set live steering defaults on a served model (operator). Fields omitted are cleared; clear: true resets everything.', auth: 'operator',
      schema: obj([], { row: { type: 'string' }, systemPrompt: { type: 'string' }, temperature: { type: 'number' }, topP: { type: 'number' }, maxTokens: { type: 'number' }, clear: { type: 'boolean' } }),
      handler: async (args: JsonObject) => {
        const target = steerFileFor(typeof args.row === 'string' && args.row ? args.row : undefined)
        const next: SteeringDoc = args.clear === true ? {} : {
          ...(typeof args.systemPrompt === 'string' && args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
          ...(typeof args.temperature === 'number' ? { temperature: args.temperature } : {}),
          ...(typeof args.topP === 'number' ? { topP: args.topP } : {}),
          ...(typeof args.maxTokens === 'number' ? { maxTokens: args.maxTokens } : {}),
        }
        await mkdir(dirname(target.file), { recursive: true })
        await writeFile(target.file, JSON.stringify(next) + '\n', { mode: 0o600 })
        return { steered: target.row, file: target.file, steering: next, rows: listRows() }
      } },
    { name: 'inference_steer_status', description: 'Current live steering on served models (capability-gated)', auth: 'capability', requiredScopes: ['inference', 'tasks'],
      schema: obj([], { row: { type: 'string' } }),
      handler: async (args: JsonObject) => {
        if (typeof args.row === 'string' && args.row) {
          const target = steerFileFor(args.row)
          return { row: target.row, steering: await readSteer(target.file) }
        }
        const rows: Record<string, SteeringDoc> = {}
        for (const row of listRows()) rows[row] = await readSteer(steerFileFor(row).file)
        return { rows }
      } },
  ]
}
