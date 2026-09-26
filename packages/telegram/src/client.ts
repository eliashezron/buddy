import { ChannelSendError, type Logger } from '@wa/core'
import { z } from 'zod'

/**
 * The only code allowed to call the Telegram Bot API. The bot token is part of
 * every URL, so URLs are never logged (the logger also redacts token-shaped strings).
 */
/**
 * An inline keyboard button: `data` comes back in a callback query (max 64 bytes);
 * `url` opens a link in the browser.
 */
export type InlineButton = { text: string; data: string } | { text: string; url: string }

export interface SendMessageOptions {
  html?: boolean
  buttons?: InlineButton[][]
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string, opts?: SendMessageOptions): Promise<{ messageId: string }>
  sendChatAction(chatId: string, action: 'typing'): Promise<void>
  /** Stops the button's loading spinner; `text` shows briefly at the top of the chat. */
  answerCallbackQuery(callbackId: string, text?: string): Promise<void>
  /** Removes the inline keyboard from one of our messages. */
  removeButtons(chatId: string, messageId: string): Promise<void>
  /** Downloads a file users sent (e.g. a voice note). The Bot API serves up to 20 MB. */
  downloadFile(fileId: string): Promise<{ data: Uint8Array; sizeBytes?: number }>
  /** Sends an OGG/Opus voice note. */
  sendVoice(chatId: string, audio: Uint8Array): Promise<{ messageId: string }>
}

/** Update types we subscribe to: messages, and presses of our inline buttons (approvals). */
export const ALLOWED_UPDATES = ['message', 'callback_query']

export class TelegramApiError extends ChannelSendError {
  override name = 'TelegramApiError'
  constructor(
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSec?: number,
  ) {
    // 429 and 5xx are transient. 400 (bad request) and 403 (user blocked the bot) are permanent.
    super(`telegram ${errorCode}: ${description}`, !(errorCode === 429 || errorCode >= 500))
  }
}

const responseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number(),
    description: z.string(),
    parameters: z.object({ retry_after: z.number().optional() }).optional(),
  }),
])

const sentMessageSchema = z.object({ message_id: z.number() })
const webhookInfoSchema = z.looseObject({
  url: z.string(),
  pending_update_count: z.number(),
  last_error_message: z.string().optional(),
})

export interface BotApiClientOptions {
  token: string
  logger: Logger
  fetch?: typeof fetch
  maxAttempts?: number
  timeoutMs?: number
  baseUrl?: string
}

export class BotApiClient implements TelegramClient {
  private readonly fetchImpl: typeof fetch
  private readonly base: string

  constructor(private readonly opts: BotApiClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    this.base = `${opts.baseUrl ?? 'https://api.telegram.org'}/bot${opts.token}`
  }

  async sendMessage(chatId: string, text: string, opts: SendMessageOptions = {}) {
    const result = await this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(opts.html ? { parse_mode: 'HTML' } : {}),
      ...(opts.buttons
        ? { reply_markup: { inline_keyboard: opts.buttons.map((row) => row.map((b) => ('url' in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } }
        : {}),
      link_preview_options: { is_disabled: true },
    })
    return { messageId: String(sentMessageSchema.parse(result).message_id) }
  }

  async sendChatAction(chatId: string, action: 'typing') {
    await this.call('sendChatAction', { chat_id: chatId, action }, { maxAttempts: 1 })
  }

  async answerCallbackQuery(callbackId: string, text?: string) {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }, { maxAttempts: 1 })
  }

  async removeButtons(chatId: string, messageId: string) {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: Number(messageId), reply_markup: { inline_keyboard: [] } }, { maxAttempts: 1 })
  }

  async sendVoice(chatId: string, audio: Uint8Array) {
    const form = new FormData()
    form.set('chat_id', chatId)
    form.set('voice', new Blob([audio], { type: 'audio/ogg' }), 'reply.ogg')
    const result = await this.call('sendVoice', form, { timeoutMs: 60_000 })
    return { messageId: String(sentMessageSchema.parse(result).message_id) }
  }

  async downloadFile(fileId: string) {
    const file = z.looseObject({ file_path: z.string().optional(), file_size: z.number().optional() }).parse(await this.call('getFile', { file_id: fileId }))
    if (!file.file_path) throw new TelegramApiError(400, 'Bad Request: file is too big to download')
    // The URL contains the bot token: it is never logged, and errors don't include it.
    const origin = this.opts.baseUrl ?? 'https://api.telegram.org'
    const res = await this.fetchImpl(`${origin}/file/bot${this.opts.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new TelegramApiError(res.status, `file download failed (HTTP ${res.status})`)
    return { data: new Uint8Array(await res.arrayBuffer()), ...(file.file_size !== undefined ? { sizeBytes: file.file_size } : {}) }
  }

  /** Long polling. Only works while no webhook is set. */
  async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES },
      { timeoutMs: (timeoutSec + 10) * 1000, maxAttempts: 1, ...(signal ? { signal } : {}) },
    )
    return z.array(z.unknown()).parse(result)
  }

  async setWebhook(url: string, secretToken: string) {
    await this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ALLOWED_UPDATES, max_connections: 40 })
  }

  async deleteWebhook() {
    await this.call('deleteWebhook', { drop_pending_updates: false })
  }

  async getWebhookInfo() {
    return webhookInfoSchema.parse(await this.call('getWebhookInfo', {}))
  }

  async getMe() {
    return z.looseObject({ id: z.number(), username: z.string() }).parse(await this.call('getMe', {}))
  }

  private async call(
    method: string,
    payload: unknown,
    overrides: { maxAttempts?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const maxAttempts = overrides.maxAttempts ?? this.opts.maxAttempts ?? 3
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce(method, payload, overrides)
      } catch (err) {
        const transient = err instanceof TelegramApiError ? !err.permanent : !overrides.signal?.aborted
        if (!transient || attempt >= maxAttempts) throw err
        const retryAfterMs = err instanceof TelegramApiError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0
        const delay = Math.min(30_000, Math.max(retryAfterMs, 250 * 2 ** attempt * (0.5 + Math.random())))
        this.opts.logger.warn({ method, attempt, delayMs: Math.round(delay), err }, 'telegram call failed, retrying')
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private async callOnce(
    method: string,
    payload: unknown,
    overrides: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(overrides.timeoutMs ?? this.opts.timeoutMs ?? 10_000)
    // Uploads (sendVoice) are multipart; everything else is JSON.
    const multipart = payload instanceof FormData
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: 'POST',
      ...(multipart ? { body: payload } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      signal: overrides.signal ? AbortSignal.any([overrides.signal, timeout]) : timeout,
    })
    const json = responseSchema.safeParse(await res.json().catch(() => undefined))
    if (!json.success) throw new TelegramApiError(res.status || 500, `unexpected response (HTTP ${res.status})`)
    if (!json.data.ok) {
      const { error_code, description, parameters } = json.data
      throw new TelegramApiError(error_code, description, parameters?.retry_after)
    }
    return json.data.result
  }
}

export type TelegramCall =
  | { method: 'sendMessage'; chatId: string; text: string; html: boolean; buttons?: InlineButton[][] }
  | { method: 'sendChatAction'; chatId: string; action: string }
  | { method: 'answerCallbackQuery'; callbackId: string; text?: string }
  | { method: 'removeButtons'; chatId: string; messageId: string }
  | { method: 'downloadFile'; fileId: string }
  | { method: 'sendVoice'; chatId: string; bytes: number }

/** Records every outbound call. Use in tests and `pnpm replay`; nothing reaches Telegram. */
export class FakeTelegramClient implements TelegramClient {
  readonly calls: TelegramCall[] = []
  /** Set to make the next sendMessage with html fail like Telegram does on bad markup. */
  failNextHtml = false
  private seq = 0

  async sendMessage(chatId: string, text: string, opts: SendMessageOptions = {}) {
    if (opts.html && this.failNextHtml) {
      this.failNextHtml = false
      throw new TelegramApiError(400, "Bad Request: can't parse entities: unexpected end tag")
    }
    this.calls.push({ method: 'sendMessage', chatId, text, html: opts.html ?? false, ...(opts.buttons ? { buttons: opts.buttons } : {}) })
    return { messageId: String(++this.seq) }
  }

  async sendChatAction(chatId: string, action: 'typing') {
    this.calls.push({ method: 'sendChatAction', chatId, action })
  }

  async answerCallbackQuery(callbackId: string, text?: string) {
    this.calls.push({ method: 'answerCallbackQuery', callbackId, ...(text ? { text } : {}) })
  }

  async removeButtons(chatId: string, messageId: string) {
    this.calls.push({ method: 'removeButtons', chatId, messageId })
  }

  /** Files tests can "download", by file id. */
  readonly files = new Map<string, Uint8Array>()

  async sendVoice(chatId: string, audio: Uint8Array) {
    this.calls.push({ method: 'sendVoice', chatId, bytes: audio.length })
    return { messageId: String(++this.seq) }
  }

  async downloadFile(fileId: string) {
    this.calls.push({ method: 'downloadFile', fileId })
    const data = this.files.get(fileId)
    if (!data) throw new TelegramApiError(400, 'Bad Request: invalid file_id')
    return { data, sizeBytes: data.length }
  }

  get sent() {
    return this.calls.filter((c): c is Extract<TelegramCall, { method: 'sendMessage' }> => c.method === 'sendMessage')
  }
}
