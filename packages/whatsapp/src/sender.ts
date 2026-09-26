import { approvalButtonId, ChannelSendError, MediaTooLargeError, type Channel, type InboundMessage } from '@wa/core'
import { BUTTON_BODY_MAX, BUTTON_TITLE_MAX, GraphApiError, MediaSizeError, type WhatsAppClient } from './client.js'
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
  async function assertWindowOpen(to: string) {
    const last = await getLastInboundAt(to)
    if (!last || now().getTime() - last.getTime() >= SERVICE_WINDOW_MS) {
      throw new OutsideServiceWindowError(last)
    }
  }
  const channel: Channel = {
    name: 'whatsapp',
    async sendText(to, markdown) {
      await assertWindowOpen(to)
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
    async sendApproval(to, card) {
      await assertWindowOpen(to)
      const buttons = [
        { id: approvalButtonId('approve', card.actionId), title: card.approveLabel.slice(0, BUTTON_TITLE_MAX) },
        { id: approvalButtonId('cancel', card.actionId), title: (card.cancelLabel ?? 'Cancel').slice(0, BUTTON_TITLE_MAX) },
      ]
      const body = toWhatsAppText(card.preview)
      if (body.length <= BUTTON_BODY_MAX) return [(await client.sendButtons(to, body, buttons)).messageId]
      // A button message holds 1024 chars: send the full text first, then the buttons.
      const ids = await channel.sendText(to, card.preview)
      const title = card.title.length > 200 ? `${card.title.slice(0, 199)}…` : card.title
      ids.push((await client.sendButtons(to, toWhatsAppText(`**${title}**: approve the message above?`), buttons)).messageId)
      return ids
    },
    async sendLink(to, link) {
      await assertWindowOpen(to)
      const body = toWhatsAppText(link.text)
      if (body.length <= BUTTON_BODY_MAX) {
        try {
          return [(await client.sendUrlButton(to, body, link.label.slice(0, BUTTON_TITLE_MAX), link.url)).messageId]
        } catch (err) {
          // A rejected button (4xx) falls back to the plain link; transient errors are retried by the queue.
          if (!(err instanceof GraphApiError && err.permanent)) throw err
        }
      }
      return channel.sendText(to, link.text.includes(link.url) ? link.text : `${link.text}\n${link.url}`)
    },
    async sendVoice(to, audio) {
      await assertWindowOpen(to)
      return [(await client.sendVoice(to, audio.data)).messageId]
    },
    async downloadMedia(message, { maxBytes }) {
      if (!message.media) throw new Error('message has no media')
      try {
        return await client.downloadMedia(message.media.id, { maxBytes })
      } catch (err) {
        if (err instanceof MediaSizeError) throw new MediaTooLargeError(err.message)
        throw err
      }
    },
    // Reply buttons can't be removed on WhatsApp. A later tap on a decided card is a no-op.
    async closeApproval() {},
  }
  return channel
}
