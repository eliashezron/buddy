/**
 * Channel-agnostic contract (PRD D6). WhatsApp is the primary channel; Telegram is
 * the second. Everything past the webhook (queue, worker, agent, DB) sees only these
 * types, so adding a channel means a parser and a `Channel` implementation.
 */

export const CHANNELS = ['whatsapp', 'telegram'] as const
export type ChannelName = (typeof CHANNELS)[number]

/** One inbound message, normalised. JSON-serialisable: it goes on a queue. */
export interface InboundMessage {
  channel: ChannelName
  /** Unique within the channel; the dedup key (wamid, or `<botId>:<chatId>:<message_id>` on Telegram). */
  id: string
  /** The user's address on the channel (wa_id, Telegram private chat id). Replies go here. */
  from: string
  /** Unix seconds. */
  timestamp: number
  /** text | audio | image | document | video | sticker | interactive | button | command | … */
  type: string
  /** The platform's own message id, for read receipts and quoting. */
  platformMessageId: string
  contactName?: string
  replyToId?: string
  /** Forwarded content is untrusted data, never instructions. */
  forwarded?: boolean
  text?: string
  /** Bot command without the slash, e.g. `start` (Telegram). */
  command?: string
  media?: { kind: string; id: string; mimeType?: string; caption?: string; voice?: boolean }
  /** Interactive button/list reply, or template quick-reply button. */
  reply?: { id: string; title: string }
}

/** Delivery status for a message we sent (WhatsApp only today). */
export interface StatusUpdate {
  channel: ChannelName
  id: string
  status: string
  timestamp: number
  recipientId: string
  errorCodes: number[]
}

export type ChannelEvent = { kind: 'message'; message: InboundMessage } | { kind: 'status'; status: StatusUpdate }

/** Outbound side of a channel. The only way the worker talks to a user. */
export interface Channel {
  name: ChannelName
  /**
   * Renders the agent's light Markdown for this channel, splits to size, applies
   * channel rules (e.g. WhatsApp's 24 h window) and sends. Returns platform message ids.
   */
  sendText(to: string, markdown: string): Promise<string[]>
  /** Read receipt / typing indicator while the agent works. Returns a function that stops it. */
  startTyping(message: InboundMessage): () => void
}

/** Send failures. `permanent` ones are logged and dropped; the rest are retried by the queue. */
export class ChannelSendError extends Error {
  override name = 'ChannelSendError'
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message)
  }
}
