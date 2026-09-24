import type { ChannelEvent, InboundMessage } from '@wa/core'
import { telegramMessageSchema, telegramUpdateSchema, type TelegramMessage } from './schemas.js'

export interface TelegramParseResult {
  updateId: number
  events: ChannelEvent[]
  /** Updates we saw but don't handle. Counted, never dropped silently. */
  skipped: { field: string; reason: string }[]
}

export class InvalidUpdateError extends Error {
  override name = 'InvalidUpdateError'
}

const MEDIA: [keyof TelegramMessage, string][] = [
  ['voice', 'audio'],
  ['audio', 'audio'],
  ['photo', 'image'],
  ['document', 'document'],
  ['video', 'video'],
  ['sticker', 'sticker'],
]

function toInbound(m: TelegramMessage): InboundMessage {
  const chatId = String(m.chat.id)
  const out: InboundMessage = {
    channel: 'telegram',
    // message_id is only unique within a chat.
    id: `${chatId}:${m.message_id}`,
    from: chatId,
    timestamp: m.date,
    type: 'text',
    platformMessageId: String(m.message_id),
  }
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ')
  if (name) out.contactName = name
  if (m.reply_to_message) out.replyToId = `${chatId}:${m.reply_to_message.message_id}`
  if (m.forward_origin || m.forward_date) out.forwarded = true

  if (m.text !== undefined) {
    const first = m.entities?.[0]
    if (first?.type === 'bot_command' && first.offset === 0) {
      // "/start@MyBot args" → command "start", text "args"
      out.type = 'command'
      out.command = m.text.slice(1, first.length).split('@')[0]!.toLowerCase()
      out.text = m.text.slice(first.length).trim()
    } else {
      out.text = m.text
    }
    return out
  }

  for (const [key, kind] of MEDIA) {
    const value = m[key]
    if (!value) continue
    // Photos arrive as several sizes; the last is the largest.
    const file = (Array.isArray(value) ? value.at(-1) : value) as { file_id: string; mime_type?: string }
    out.type = kind
    out.media = { kind, id: file.file_id }
    if (file.mime_type) out.media.mimeType = file.mime_type
    if (key === 'voice') out.media.voice = true
    if (m.caption) out.media.caption = m.caption
    return out
  }

  out.type = 'unsupported'
  return out
}

/**
 * Parses one Telegram `Update` whose secret token has already been verified.
 * Only private chats are handled: the bot never reads groups or channels.
 */
export function parseTelegramUpdate(json: unknown): TelegramParseResult {
  const update = telegramUpdateSchema.safeParse(json)
  if (!update.success) throw new InvalidUpdateError('not a Telegram update')
  const { update_id: updateId, message, ...rest } = update.data

  if (message === undefined) {
    const field = Object.keys(rest)[0] ?? 'unknown'
    return { updateId, events: [], skipped: [{ field, reason: 'unhandled update type' }] }
  }
  const parsed = telegramMessageSchema.safeParse(message)
  if (!parsed.success) return { updateId, events: [], skipped: [{ field: 'message', reason: 'malformed message' }] }
  const m = parsed.data
  if (m.chat.type !== 'private') return { updateId, events: [], skipped: [{ field: 'message', reason: 'non-private chat' }] }
  if (m.from?.is_bot) return { updateId, events: [], skipped: [{ field: 'message', reason: 'sent by a bot' }] }

  return { updateId, events: [{ kind: 'message', message: toInbound(m) }], skipped: [] }
}
