import { ChannelSendError, type Channel, type InboundMessage } from '@wa/core'
import type { WhatsAppClient } from './client.js'
import { splitMessage, toWhatsAppText } from './format.js'

export const SERVICE_WINDOW_MS = 24 * 60 * 60_000

export class OutsideServiceWindowError extends ChannelSendError {
  override name = 'OutsideServiceWindowError'
  constructor(readonly lastInboundAt: Date | null) {
    super('24-hour customer service window is closed; use an approved template or queue the message', true)
  }
}

export interface WhatsAppChannelDeps {
  client: WhatsAppClient
  /** Reads `users.last_inbound_at`. Checked on every send, in the channel, not the caller. */
  getLastInboundAt(waId: string): Promise<Date | null>
  now?: () => Date
  onTypingError?: (err: unknown) => void
}

/**
 * WhatsApp as a `Channel`: Markdown → WhatsApp formatting, 4096-char chunks, and the
 * 24 h customer service window enforced before every free-form send.
 */
export function createWhatsAppChannel({
  client,
  getLastInboundAt,
  now = () => new Date(),
  onTypingError = () => {},
}: WhatsAppChannelDeps): Channel {
  return {
    name: 'whatsapp',
    async sendText(to, markdown) {
      const last = await getLastInboundAt(to)
      if (!last || now().getTime() - last.getTime() >= SERVICE_WINDOW_MS) {
        throw new OutsideServiceWindowError(last)
      }
      const ids: string[] = []
      for (const chunk of splitMessage(toWhatsAppText(markdown))) {
        const { messageId } = await client.sendText(to, chunk)
        ids.push(messageId)
      }
      return ids
    },
    startTyping(message: InboundMessage) {
      // One call marks the message read and shows "typing…" until we reply (max ~25 s).
      client.markRead(message.platformMessageId, { typing: true }).catch(onTypingError)
      return () => {}
    },
  }
}
