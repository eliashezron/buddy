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
  /** Telegram inline-button press: the callback query to answer. */
  callbackId?: string
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
  /**
   * Sends an approval card: the full preview plus Approve / Cancel buttons whose ids come
   * from `approvalButtonId`. Only a press of one of these buttons can approve an action.
   */
  sendApproval(to: string, card: ApprovalCard): Promise<string[]>
  /** After a button press: stop the client's spinner and close the card, where the platform allows it. */
  closeApproval(message: InboundMessage, outcome: string): Promise<void>
  /**
   * Sends `text` with a button that opens `url` in the browser. If the platform rejects
   * the button (e.g. a localhost URL), sends the text alone, adding the URL unless the
   * text already shows it.
   */
  sendLink(to: string, link: LinkButton): Promise<string[]>
}

export interface LinkButton {
  /** Markdown shown above the button. May include the URL for users who prefer to copy it. */
  text: string
  url: string
  /** Button label, max 20 characters (WhatsApp's limit). */
  label: string
}

export interface ApprovalCard {
  actionId: string
  /** Everything that will be sent, from the tool's `preview`. */
  preview: string
  /** One line, from the tool's `title`. */
  title: string
  approveLabel: string
}

export type ApprovalDecision = 'approve' | 'cancel'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const BUTTON_ID = new RegExp(`^(approve|cancel):(${UUID})$`)

/** Button payload for an approval card: `approve:<action id>` (44 chars, under Telegram's 64-byte limit). */
export function approvalButtonId(decision: ApprovalDecision, actionId: string): string {
  return `${decision}:${actionId}`
}

/** Parses a button payload. Anything else, including typed text that looks like one, is not a decision. */
export function parseApprovalButton(id: string): { decision: ApprovalDecision; actionId: string } | null {
  const m = BUTTON_ID.exec(id)
  return m ? { decision: m[1] as ApprovalDecision, actionId: m[2]! } : null
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
