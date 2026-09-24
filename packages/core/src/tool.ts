import type { z } from 'zod'
import type { Logger } from './logger.js'

export type Risk = 'read' | 'low_write' | 'outbound' | 'money'

export interface ToolContext {
  userId: string
  runId: string
  actionId: string
  /** The user's IANA timezone. Resolve relative dates before calling tools. */
  timezone: string
  now: Date
  logger: Logger
  signal?: AbortSignal
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string
  /** Shown to the model. Say when to use the tool and when not to. */
  description: string
  risk: Risk
  input: I
  /** Shown to the user before an approved action runs. */
  preview(input: z.infer<I>): string
  execute(input: z.infer<I>, ctx: ToolContext): Promise<O>
}

export function defineTool<I extends z.ZodType, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) throw new Error(`invalid tool name: ${def.name}`)
  return def
}

/** Registry element type. Methods (not function properties) keep this assignable. */
export type AnyTool = ToolDefinition<z.ZodType, unknown>
