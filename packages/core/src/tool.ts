import type { z } from 'zod'
import type { Capability, ToolServices } from './connections.js'
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
  /** Per-user credentials, connections and undo. */
  services: ToolServices
  signal?: AbortSignal
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string
  /** Shown to the model. Say when to use the tool and when not to. */
  description: string
  risk: Risk
  input: I
  /**
   * Shown to the user before an approved action runs. For `outbound` and `money` tools it
   * is the approval card, so it must show everything that will be sent (recipients, full text).
   */
  preview(input: z.infer<I>): string
  /** One line for approval buttons and confirmations, e.g. `Email to kato@example.com`. */
  title?(input: z.infer<I>): string
  /**
   * Permissions checked before asking for approval, so a missing one sends a connect link
   * instead of a card the user can't use.
   */
  requires?(input: z.infer<I>): Capability[]
  execute(input: z.infer<I>, ctx: ToolContext): Promise<O>
  /** low_write tools: reverses a successful execute (offered for 10 minutes). */
  undo?(result: O, ctx: ToolContext): Promise<void>
}

export function defineTool<I extends z.ZodType, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) throw new Error(`invalid tool name: ${def.name}`)
  return def
}

/** Registry element type. Methods (not function properties) keep this assignable. */
export type AnyTool = ToolDefinition<z.ZodType, unknown>
