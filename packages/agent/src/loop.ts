import Anthropic from '@anthropic-ai/sdk'
import { decide, type AnyTool, type ChannelName, type Logger, type Risk } from '@wa/core'
import { z } from 'zod'
import { buildSystemPrompt, wrapForwarded } from './prompt.js'

type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam
export type CreateMessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

/** Injected so tests and evals can script the model. Production passes `anthropic.beta.messages.create`. */
export type CreateMessage = (params: CreateMessageParams, opts?: { signal?: AbortSignal }) => Promise<BetaMessage>

export type ActionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'awaiting_approval' | 'expired' | 'cancelled'

/** Persistence for the `actions` table. No tool runs without a row. */
export interface ActionLog {
  create(input: { tool: string; risk: Risk; status: ActionStatus; input: unknown; approvalExpiresAt?: Date }): Promise<string>
  update(id: string, patch: { status: ActionStatus; result?: unknown; error?: string; undoExpiresAt?: Date }): Promise<void>
}

export interface HistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface RunAgentInput {
  createMessage: CreateMessage
  model: string
  tools: AnyTool[]
  actions: ActionLog
  logger: Logger
  runId: string
  user: { id: string; name?: string; timezone: string }
  /** Which chat app this conversation is on; shapes the prompt. */
  channel: ChannelName
  history: HistoryTurn[]
  message: { text: string; forwarded?: boolean }
  now?: Date
  signal?: AbortSignal
  maxTurns?: number
}

export interface ToolCallRecord {
  name: string
  input: unknown
  actionId?: string
  outcome: 'succeeded' | 'failed' | 'blocked' | 'invalid'
}

export interface RunAgentResult {
  status: 'succeeded' | 'refused' | 'failed'
  reply: string
  toolCalls: ToolCallRecord[]
  usage: { inputTokens: number; outputTokens: number }
}

const MAX_TOKENS = 16_000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Worth retrying later: rate limits, overload, timeouts, network. Auth and bad requests are not. */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  return false
}

export const REFUSAL_REPLY = "Sorry, I can't help with that one."
export const FAILURE_REPLY = "Sorry, something went wrong on my side. Please try again in a moment."

function toolParam(tool: AnyTool): Anthropic.Beta.Messages.BetaTool {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>
  return {
    name: tool.name,
    description: tool.description,
    strict: true,
    input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
  }
}

/** Collapses stored history into alternating, non-empty turns, starting with the user. */
export function buildMessages(history: HistoryTurn[], current: string): BetaMessageParam[] {
  const turns: HistoryTurn[] = []
  // The API rejects empty turns, so blank history entries are dropped here.
  for (const t of [...history, { role: 'user' as const, text: current }].filter((t) => t.text.trim())) {
    const last = turns.at(-1)
    if (last && last.role === t.role) last.text = `${last.text}\n\n${t.text}`
    else turns.push({ ...t })
  }
  while (turns[0]?.role === 'assistant') turns.shift()
  return turns.map((t) => ({ role: t.role, content: t.text }))
}

function textOf(message: BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { createMessage, tools, actions, logger, runId, user } = input
  const now = input.now ?? new Date()
  const maxTurns = input.maxTurns ?? 8
  const byName = new Map(tools.map((t) => [t.name, t]))
  const toolParams = tools.map(toolParam)
  const usage = { inputTokens: 0, outputTokens: 0 }
  const toolCalls: ToolCallRecord[] = []

  const current = input.message.forwarded ? wrapForwarded(input.message.text) : input.message.text
  const messages = buildMessages(input.history, current)
  const promptCtx = { channel: input.channel, timezone: user.timezone, now, ...(user.name ? { userName: user.name } : {}) }
  const system = buildSystemPrompt(promptCtx)

  async function runTool(block: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
    const result = (content: unknown, isError = false): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      ...(isError ? { is_error: true } : {}),
    })

    const tool = byName.get(block.name)
    if (!tool) {
      toolCalls.push({ name: block.name, input: block.input, outcome: 'invalid' })
      return result(`Unknown tool: ${block.name}`, true)
    }
    const parsed = tool.input.safeParse(block.input)
    if (!parsed.success) {
      toolCalls.push({ name: tool.name, input: block.input, outcome: 'invalid' })
      return result(`Invalid input: ${z.prettifyError(parsed.error)}`, true)
    }

    const decision = decide(tool.risk)
    if (decision.kind === 'needs_approval') {
      // Approval buttons land with the first outbound tool (T5). Until then an
      // outbound/money call is recorded and refused, never executed.
      const actionId = await actions.create({ tool: tool.name, risk: tool.risk, status: 'cancelled', input: parsed.data })
      await actions.update(actionId, { status: 'cancelled', error: 'approval flow not available yet' })
      toolCalls.push({ name: tool.name, input: parsed.data, actionId, outcome: 'blocked' })
      return result('This action needs the user\'s approval, which is not available yet. Do not retry; tell the user.', true)
    }

    // Row first, then execution.
    const actionId = await actions.create({ tool: tool.name, risk: tool.risk, status: 'running', input: parsed.data })
    const ctx = {
      userId: user.id,
      runId,
      actionId,
      timezone: user.timezone,
      now,
      logger: logger.child({ tool: tool.name, actionId }),
      ...(input.signal ? { signal: input.signal } : {}),
    }
    try {
      const output = await tool.execute(parsed.data, ctx)
      const failed = typeof output === 'object' && output !== null && 'ok' in output && output.ok === false
      await actions.update(actionId, {
        status: failed ? 'failed' : 'succeeded',
        result: output,
        ...(decision.kind === 'run_with_undo' ? { undoExpiresAt: new Date(Date.now() + decision.undoWindowMs) } : {}),
      })
      toolCalls.push({ name: tool.name, input: parsed.data, actionId, outcome: failed ? 'failed' : 'succeeded' })
      return result(output, failed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await actions.update(actionId, { status: 'failed', error: message })
      toolCalls.push({ name: tool.name, input: parsed.data, actionId, outcome: 'failed' })
      logger.warn({ err, tool: tool.name, actionId }, 'tool failed')
      return result(`Tool failed: ${message}`, true)
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    const lastTurn = turn === maxTurns - 1
    const response = await createMessage(
      {
        model: input.model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools: toolParams,
        // On the final turn, force a written answer from what we have.
        ...(lastTurn ? { tool_choice: { type: 'none' as const } } : {}),
        thinking: { type: 'adaptive' },
        // Replies go to phones; favour latency over exhaustive deliberation.
        output_config: { effort: 'medium' },
        // Re-run policy declines on Anthropic's recommended fallback model.
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      },
      input.signal ? { signal: input.signal } : undefined,
    )
    usage.inputTokens += response.usage.input_tokens
    usage.outputTokens += response.usage.output_tokens

    if (response.stop_reason === 'refusal') {
      return { status: 'refused', reply: REFUSAL_REPLY, toolCalls, usage }
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      const reply = textOf(response)
      if (!reply) return { status: 'failed', reply: FAILURE_REPLY, toolCalls, usage }
      return { status: 'succeeded', reply, toolCalls, usage }
    }
    if (response.stop_reason === 'max_tokens') {
      logger.warn({ runId }, 'tool input truncated at max_tokens')
      return { status: 'failed', reply: FAILURE_REPLY, toolCalls, usage }
    }

    messages.push({ role: 'assistant', content: response.content })
    // Parallel tool calls: run concurrently, return all results in one user message.
    const results = await Promise.all(toolUses.map(runTool))
    messages.push({ role: 'user', content: results })
  }

  return { status: 'failed', reply: FAILURE_REPLY, toolCalls, usage }
}
