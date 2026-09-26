import type Anthropic from '@anthropic-ai/sdk'
import type { CreateMessage, CreateMessageParams } from './loop.js'

/**
 * Development-only model provider: runs the agent on an OpenAI-style model (e.g.
 * gpt-6-luna) through an OpenAI Responses endpoint such as OpenCode Zen.
 *
 * The agent loop speaks Anthropic's Messages format. This adapter translates one request
 * to the Responses API and the answer back, so the loop, tools and policy gate are
 * unchanged. Claude-only settings (adaptive thinking, effort, server-side fallbacks,
 * cache_control, betas) are dropped. Tool arguments are still validated with zod by the
 * loop, so non-strict function calling is safe here.
 *
 * Not for production: CLAUDE.md requires zero-retention model vendors for WhatsApp data,
 * and config validation refuses this provider when NODE_ENV=production.
 */

type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock

export class ModelProviderError extends Error {
  override name = 'ModelProviderError'
  constructor(
    message: string,
    readonly status: number,
    /** Worth retrying later: rate limits, server errors, network failures. */
    readonly transient: boolean,
  ) {
    super(message)
  }
}

type InputItem =
  | { role: 'user' | 'assistant' | 'system'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : ''))
          .filter(Boolean)
          .join('\n')
      : ''

/** Anthropic messages → Responses input items. Thinking blocks have no equivalent and are dropped. */
export function toResponsesInput(messages: CreateMessageParams['messages']): InputItem[] {
  const items: InputItem[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content) items.push({ role: m.role, content: m.content })
      continue
    }
    let text: string[] = []
    const flushText = () => {
      if (text.length) items.push({ role: m.role, content: text.join('\n') })
      text = []
    }
    for (const block of m.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'tool_use') {
        flushText()
        items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
      } else if (block.type === 'tool_result') {
        flushText()
        const output = textOf(block.content)
        items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? `ERROR: ${output}` : output })
      }
    }
    flushText()
  }
  return items
}

type ResponsesBody = {
  id?: string
  model?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  output?: (
    | { type: 'message'; content?: { type: string; text?: string }[] }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: string }
  )[]
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string } | null
}

/** Responses output → an Anthropic-shaped message the loop understands. */
export function fromResponsesOutput(body: ResponsesBody, model: string): BetaMessage {
  const content: ContentBlock[] = []
  for (const item of body.output ?? []) {
    if (item.type === 'message' && 'content' in item) {
      const text = (item.content ?? []).map((c) => (c.type === 'output_text' ? (c.text ?? '') : '')).join('')
      if (text) content.push({ type: 'text', text, citations: null } as ContentBlock)
    } else if (item.type === 'function_call' && 'call_id' in item) {
      let input: unknown = {}
      try {
        input = JSON.parse(item.arguments || '{}')
      } catch {
        // Malformed arguments: pass the raw string; the loop's zod validation reports it to the model.
        input = { _unparsed: item.arguments }
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input } as ContentBlock)
    }
  }
  const cached = body.usage?.input_tokens_details?.cached_tokens ?? 0
  const stop: BetaMessage['stop_reason'] = content.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens'
      ? 'max_tokens'
      : 'end_turn'
  return {
    id: body.id ?? 'resp',
    type: 'message',
    role: 'assistant',
    model: body.model ?? model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (body.usage?.input_tokens ?? 0) - cached),
      output_tokens: body.usage?.output_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage
}

export function toResponsesRequest(params: CreateMessageParams) {
  const system = typeof params.system === 'string' ? params.system : (params.system ?? []).map((b) => b.text).join('\n\n')
  const tools = (params.tools ?? [])
    .filter((t): t is Anthropic.Beta.Messages.BetaTool => 'input_schema' in t)
    .map((t) => ({ type: 'function' as const, name: t.name, description: t.description ?? '', parameters: t.input_schema, strict: false }))
  const choice = params.tool_choice?.type
  return {
    model: params.model,
    ...(system ? { instructions: system } : {}),
    input: toResponsesInput(params.messages),
    ...(tools.length ? { tools } : {}),
    ...(choice === 'none' ? { tool_choice: 'none' } : {}),
    max_output_tokens: params.max_tokens,
    // Stateless, like the Anthropic calls: the loop resends history each turn.
    store: false,
  }
}

export function createResponsesMessage(opts: { apiKey: string; baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }): CreateMessage {
  const fetchImpl = opts.fetch ?? fetch
  const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/responses`
  return async (params, callOpts) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 90_000)
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toResponsesRequest(params)),
        signal: callOpts?.signal ? AbortSignal.any([callOpts.signal, timeout]) : timeout,
      })
    } catch (err) {
      throw new ModelProviderError(`model request failed: ${err instanceof Error ? err.message : String(err)}`, 0, true)
    }
    const body = (await res.json().catch(() => ({}))) as ResponsesBody
    if (!res.ok || body.error) {
      const status = res.ok ? 500 : res.status
      const message = body.error?.message ?? `HTTP ${res.status}`
      throw new ModelProviderError(`model request failed: ${message}`, status, status === 408 || status === 409 || status === 429 || status >= 500)
    }
    return fromResponsesOutput(body, params.model)
  }
}
