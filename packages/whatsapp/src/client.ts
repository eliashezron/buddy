import { z } from 'zod'
import { ChannelSendError, type Logger } from '@wa/core'

/**
 * The only code allowed to talk to the Graph API. Routes, tools and workers get a
 * `WhatsAppClient` (or the window-guarded `Sender`) and never `fetch` Graph directly.
 */
export interface WhatsAppClient {
  sendText(to: string, body: string, opts?: { replyToId?: string; previewUrl?: boolean }): Promise<{ messageId: string }>
  /** Marks an inbound message read and, optionally, shows the typing indicator while we work. */
  markRead(messageId: string, opts?: { typing?: boolean }): Promise<void>
  /** Interactive reply buttons: body ≤ 1024 chars, up to 3 buttons, titles ≤ 20 chars, ids ≤ 256. */
  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<{ messageId: string }>
  /** Call-to-action URL button: body ≤ 1024 chars, label ≤ 20 chars. */
  sendUrlButton(to: string, body: string, label: string, url: string): Promise<{ messageId: string }>
}

export const BUTTON_BODY_MAX = 1024
export const BUTTON_TITLE_MAX = 20

export class GraphApiError extends ChannelSendError {
  override name = 'GraphApiError'
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    // 5xx and 429 are retryable; every other 4xx is permanent (whatsapp-notes.md §5).
    super(message, !(status >= 500 || status === 429 || code === 130429))
  }
  get retryable(): boolean {
    return !this.permanent
  }
}

const sendResponseSchema = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) })
const errorResponseSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.number().optional() }),
})

export interface CloudApiClientOptions {
  accessToken: string
  phoneNumberId: string
  graphApiVersion: string
  logger: Logger
  fetch?: typeof fetch
  maxAttempts?: number
  timeoutMs?: number
}

export class CloudApiClient implements WhatsAppClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(private readonly opts: CloudApiClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    this.baseUrl = `https://graph.facebook.com/${opts.graphApiVersion}/${opts.phoneNumberId}`
  }

  async sendText(to: string, body: string, opts: { replyToId?: string; previewUrl?: boolean } = {}) {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: opts.previewUrl ?? false },
    }
    if (opts.replyToId) payload.context = { message_id: opts.replyToId }
    const json = await this.post('/messages', payload)
    const parsed = sendResponseSchema.safeParse(json)
    if (!parsed.success) throw new GraphApiError(200, undefined, 'unexpected send response shape')
    return { messageId: parsed.data.messages[0]!.id }
  }

  async sendButtons(to: string, body: string, buttons: { id: string; title: string }[]) {
    const json = await this.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    })
    const parsed = sendResponseSchema.safeParse(json)
    if (!parsed.success) throw new GraphApiError(200, undefined, 'unexpected send response shape')
    return { messageId: parsed.data.messages[0]!.id }
  }

  async sendUrlButton(to: string, body: string, label: string, url: string) {
    const json = await this.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: { type: 'cta_url', body: { text: body }, action: { name: 'cta_url', parameters: { display_text: label, url } } },
    })
    const parsed = sendResponseSchema.safeParse(json)
    if (!parsed.success) throw new GraphApiError(200, undefined, 'unexpected send response shape')
    return { messageId: parsed.data.messages[0]!.id }
  }

  async markRead(messageId: string, opts: { typing?: boolean } = {}) {
    const payload: Record<string, unknown> = { messaging_product: 'whatsapp', status: 'read', message_id: messageId }
    if (opts.typing) payload.typing_indicator = { type: 'text' }
    await this.post('/messages', payload)
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const maxAttempts = this.opts.maxAttempts ?? 3
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.postOnce(path, payload)
      } catch (err) {
        const retryable = err instanceof GraphApiError ? err.retryable : true // network errors
        if (!retryable || attempt >= maxAttempts) throw err
        const delay = Math.min(8_000, 250 * 2 ** attempt) * (0.5 + Math.random())
        this.opts.logger.warn({ attempt, delayMs: Math.round(delay), err }, 'graph api call failed, retrying')
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private async postOnce(path: string, payload: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    })
    const json: unknown = await res.json().catch(() => undefined)
    if (!res.ok) {
      const parsed = errorResponseSchema.safeParse(json)
      const code = parsed.success ? parsed.data.error.code : undefined
      const message = parsed.success ? (parsed.data.error.message ?? 'graph api error') : `HTTP ${res.status}`
      throw new GraphApiError(res.status, code, message)
    }
    return json
  }
}

export type RecordedCall =
  | { method: 'sendText'; to: string; body: string; replyToId?: string }
  | { method: 'markRead'; messageId: string; typing: boolean }
  | { method: 'sendButtons'; to: string; body: string; buttons: { id: string; title: string }[] }
  | { method: 'sendUrlButton'; to: string; body: string; label: string; url: string }

/** Records every outbound call. Use this in all tests and in `pnpm replay`; nothing hits Graph. */
export class FakeWhatsAppClient implements WhatsAppClient {
  readonly calls: RecordedCall[] = []
  private seq = 0

  async sendText(to: string, body: string, opts: { replyToId?: string } = {}) {
    const call: RecordedCall = { method: 'sendText', to, body }
    if (opts.replyToId) call.replyToId = opts.replyToId
    this.calls.push(call)
    return { messageId: `wamid.FAKE_${++this.seq}` }
  }

  async markRead(messageId: string, opts: { typing?: boolean } = {}) {
    this.calls.push({ method: 'markRead', messageId, typing: opts.typing ?? false })
  }

  async sendButtons(to: string, body: string, buttons: { id: string; title: string }[]) {
    this.calls.push({ method: 'sendButtons', to, body, buttons })
    return { messageId: `wamid.FAKE_${++this.seq}` }
  }

  async sendUrlButton(to: string, body: string, label: string, url: string) {
    this.calls.push({ method: 'sendUrlButton', to, body, label, url })
    return { messageId: `wamid.FAKE_${++this.seq}` }
  }

  get sent() {
    return this.calls.filter((c): c is Extract<RecordedCall, { method: 'sendText' }> => c.method === 'sendText')
  }
}
