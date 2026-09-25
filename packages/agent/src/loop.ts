import Anthropic from '@anthropic-ai/sdk'
import {
  CAPABILITIES,
  decide,
  NeedsConnectionError,
  type AnyTool,
  type Capability,
  type ChannelName,
  type Logger,
  type Risk,
  type ToolServices,
} from '@wa/core'
import { z } from 'zod'
import { buildSystemPrompt, wrapForwarded } from './prompt.js'

type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam
export type CreateMessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

/** Injected so tests and evals can script the model. Production passes `anthropic.beta.messages.create`. */
export type CreateMessage = (params: CreateMessageParams, opts?: { signal?: AbortSignal }) => Promise<BetaMessage>

export type ActionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_approval'
  | 'expired'
  | 'cancelled'
  | 'undone'

/** Persistence for the `actions` table. No tool runs without a row. */
export interface ActionLog {
  create(input: { tool: string; risk: Risk; status: ActionStatus; input: unknown; approvalExpiresAt?: Date }): Promise<string>
  update(id: string, patch: { status: ActionStatus; result?: unknown; error?: string; undoExpiresAt?: Date; approvalExpiresAt?: Date }): Promise<void>
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
  /** Per-user credentials, connections and undo for tools. */
  services: ToolServices
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
  outcome: 'succeeded' | 'failed' | 'blocked' | 'invalid' | 'needs_connection' | 'awaiting_approval'
}

export interface RunAgentResult {
  status: 'succeeded' | 'refused' | 'failed'
  reply: string
  toolCalls: ToolCallRecord[]
  /** Capabilities a tool needed but the user hasn't granted: the caller sends a connect link. */
  connectionRequests: Capability[]
  /** `awaiting_approval` action ids: the caller sends an approval card for each. */
  approvalRequests: string[]
  /**
   * `inputTokens` is uncached input only. Cache reads cost ~0.1× and writes ~1.25× the
   * input price, so they are counted separately.
   */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
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

/**
 * Keywords strict tool use doesn't support: numeric bounds, string length and array
 * length (400: "For 'array' type, property 'maxItems' is not supported"). Only
 * `minItems` of 0 or 1 is allowed. They move into the description so the model still
 * sees the limit; zod enforces it before any tool runs.
 */
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems'] as const

function unsupported(key: string, value: unknown): boolean {
  if (key === 'minItems') return typeof value === 'number' && value > 1
  return (UNSUPPORTED as readonly string[]).includes(key)
}

export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  const bounds: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (unsupported(key, value)) bounds.push(`${key} ${String(value)}`)
    else out[key] = toStrictSchema(value)
  }
  if (bounds.length) {
    const note = `(${bounds.join(', ')})`
    out.description = typeof out.description === 'string' ? `${out.description} ${note}` : note
  }
  return out
}

export function toolParam(tool: AnyTool): Anthropic.Beta.Messages.BetaTool {
  const { $schema: _ignored, ...schema } = toStrictSchema(z.toJSONSchema(tool.input)) as Record<string, unknown>
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
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const toolCalls: ToolCallRecord[] = []
  const connectionRequests = new Set<Capability>()
  const approvalRequests: string[] = []
  const done = (status: RunAgentResult['status'], reply: string): RunAgentResult => ({
    status,
    reply,
    toolCalls,
    connectionRequests: [...connectionRequests],
    approvalRequests,
    usage,
  })

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

    // Just-in-time permission: the system sends a one-time connect link for exactly
    // these capabilities. The model must not write links itself.
    async function needsConnection(err: NeedsConnectionError, toolName: string, toolInput: unknown, actionId: string) {
      for (const c of err.capabilities) connectionRequests.add(c)
      await actions.update(actionId, { status: 'failed', error: `needs_connection:${err.problem}` })
      toolCalls.push({ name: toolName, input: toolInput, actionId, outcome: 'needs_connection' })
      const products = [...new Set(err.capabilities.map((c) => CAPABILITIES[c].product))].join(' and ')
      return result(
        {
          ok: false,
          error: err.problem === 'missing_permission' ? 'permission_needed' : 'not_connected',
          product: products,
          needs: err.capabilities.map((c) => CAPABILITIES[c].label),
          note:
            `A secure one-time link to connect ${products} is being sent to the user right after your reply. ` +
            'Tell them briefly that it is coming and what it will let you do. Do not write any link or URL ' +
            'yourself, and do not ask for passwords. Do not retry this tool now; it is re-run automatically ' +
            'after they connect.',
        },
        true,
      )
    }

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
    if (decision.kind === 'needs_approval' && tool.risk === 'money') {
      // Payments also need a PSP PIN step and spend limits (CLAUDE.md), which don't exist
      // yet. Recorded and refused, never executed.
      const actionId = await actions.create({ tool: tool.name, risk: tool.risk, status: 'cancelled', input: parsed.data })
      await actions.update(actionId, { status: 'cancelled', error: 'payments not available yet' })
      toolCalls.push({ name: tool.name, input: parsed.data, actionId, outcome: 'blocked' })
      return result('Payments are not available yet. Do not retry; tell the user.', true)
    }
    if (decision.kind === 'needs_approval') {
      // Outbound: nothing runs now. The row holds the exact input; the worker shows it on an
      // approval card, and only the user's button press (checked by action id, user and
      // expiry) executes it. The model has no way to approve or to change the input later.
      const actionId = await actions.create({ tool: tool.name, risk: tool.risk, status: 'pending', input: parsed.data })
      const requires = tool.requires?.(parsed.data) ?? []
      if (requires.length) {
        try {
          await input.services.credentials.accessToken(requires)
        } catch (err) {
          if (err instanceof NeedsConnectionError) return needsConnection(err, tool.name, parsed.data, actionId)
          throw err
        }
      }
      await actions.update(actionId, { status: 'awaiting_approval', approvalExpiresAt: new Date(Date.now() + decision.approvalTtlMs) })
      approvalRequests.push(actionId)
      toolCalls.push({ name: tool.name, input: parsed.data, actionId, outcome: 'awaiting_approval' })
      return result({
        ok: true,
        status: 'awaiting_approval',
        sent: false,
        note:
          'Nothing has been sent. Right after your reply the user gets a card showing exactly this, with ' +
          'Send and Cancel buttons; it expires in 15 minutes. Say in one short line that it is ready for them to ' +
          'check and approve. Do not repeat the content and do not say it was sent.',
      })
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
      services: input.services,
      ...(input.signal ? { signal: input.signal } : {}),
    }
    try {
      const output = await tool.execute(parsed.data, ctx)
      const failed = typeof output === 'object' && output !== null && 'ok' in output && output.ok === false
      await actions.update(actionId, {
        status: failed ? 'failed' : 'succeeded',
        result: output,
        ...(decision.kind === 'run_with_undo' && tool.undo && !failed
          ? { undoExpiresAt: new Date(Date.now() + decision.undoWindowMs) }
          : {}),
      })
      toolCalls.push({ name: tool.name, input: parsed.data, actionId, outcome: failed ? 'failed' : 'succeeded' })
      return result(output, failed)
    } catch (err) {
      if (err instanceof NeedsConnectionError) return needsConnection(err, tool.name, parsed.data, actionId)
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
        // Automatic caching of the growing conversation: each call in this tool loop reads
        // the previous call's prefix. The system prompt carries a second, explicit
        // breakpoint for tools + instructions, shared by every request.
        cache_control: { type: 'ephemeral' },
      },
      input.signal ? { signal: input.signal } : undefined,
    )
    usage.inputTokens += response.usage.input_tokens
    usage.outputTokens += response.usage.output_tokens
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0

    if (response.stop_reason === 'refusal') {
      return done('refused', REFUSAL_REPLY)
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      const reply = textOf(response)
      if (!reply) return done('failed', FAILURE_REPLY)
      return done('succeeded', reply)
    }
    if (response.stop_reason === 'max_tokens') {
      logger.warn({ runId }, 'tool input truncated at max_tokens')
      return done('failed', FAILURE_REPLY)
    }

    messages.push({ role: 'assistant', content: response.content })
    // Parallel tool calls: run concurrently, return all results in one user message.
    const results = await Promise.all(toolUses.map(runTool))
    messages.push({ role: 'user', content: results })
  }

  return done('failed', FAILURE_REPLY)
}
