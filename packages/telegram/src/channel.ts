import { approvalButtonId, MediaTooLargeError, splitText, type Channel, type InboundMessage } from '@wa/core'
import { TelegramApiError, type TelegramClient } from './client.js'
import { MAX_TEXT_LENGTH, toPlainText, toTelegramHtml } from './format.js'

/** Telegram's "typing…" lasts ~5 s, so it's refreshed until the reply is sent. */
const TYPING_REFRESH_MS = 4_500

export interface TelegramChannelDeps {
  client: TelegramClient
  /** The bot's id, from `botIdFromToken`. Part of every message id, as in `parseTelegramUpdate`. */
  botId: string
  onTypingError?: (err: unknown) => void
}

/** Telegram as a `Channel`. No service window: a bot may reply any time the user has started it. */
export function createTelegramChannel({ client, botId, onTypingError = () => {} }: TelegramChannelDeps): Channel {
  const channel: Channel = {
    name: 'telegram',
    async sendText(chatId, markdown) {
      // Returned ids are `<botId>:<chatId>:<message_id>`, matching inbound ids.
      const ids: string[] = []
      // Split the Markdown before converting, so no chunk cuts through an HTML tag.
      for (const chunk of splitText(markdown, MAX_TEXT_LENGTH)) {
        try {
          ids.push(`${botId}:${chatId}:${(await client.sendMessage(chatId, toTelegramHtml(chunk), { html: true })).messageId}`)
        } catch (err) {
          const badMarkup = err instanceof TelegramApiError && err.errorCode === 400 && /parse entities/i.test(err.description)
          if (!badMarkup) throw err
          ids.push(`${botId}:${chatId}:${(await client.sendMessage(chatId, toPlainText(chunk))).messageId}`)
        }
      }
      return ids
    },
    startTyping(message: InboundMessage) {
      let reported = false
      const tick = () =>
        client.sendChatAction(message.from, 'typing').catch((err: unknown) => {
          if (!reported) onTypingError(err)
          reported = true
        })
      void tick()
      const timer = setInterval(tick, TYPING_REFRESH_MS)
      return () => clearInterval(timer)
    },
    async sendApproval(chatId, card) {
      const buttons = [
        [
          { text: `✅ ${card.approveLabel}`, data: approvalButtonId('approve', card.actionId) },
          { text: '✖ Cancel', data: approvalButtonId('cancel', card.actionId) },
        ],
      ]
      const html = toTelegramHtml(card.preview)
      if (html.length <= MAX_TEXT_LENGTH) {
        return [`${botId}:${chatId}:${(await client.sendMessage(chatId, html, { html: true, buttons })).messageId}`]
      }
      // Too long for one message: the full text first, then a short card with the buttons.
      const ids = await channel.sendText(chatId, card.preview)
      const title = toTelegramHtml(`**${card.title}**: approve the message above?`)
      ids.push(`${botId}:${chatId}:${(await client.sendMessage(chatId, title, { html: true, buttons })).messageId}`)
      return ids
    },
    async sendLink(chatId, link) {
      try {
        const html = toTelegramHtml(link.text)
        return [`${botId}:${chatId}:${(await client.sendMessage(chatId, html, { html: true, buttons: [[{ text: link.label, url: link.url }]] })).messageId}`]
      } catch (err) {
        // Telegram rejects some button URLs (localhost, for one) with a 400. The link still works as text.
        if (!(err instanceof TelegramApiError && err.errorCode === 400)) throw err
        return channel.sendText(chatId, link.text.includes(link.url) ? link.text : `${link.text}\n${link.url}`)
      }
    },
    async sendVoice(chatId, audio) {
      return [`${botId}:${chatId}:${(await client.sendVoice(chatId, audio.data)).messageId}`]
    },
    async downloadMedia(message, { maxBytes }) {
      if (!message.media) throw new Error('message has no media')
      // Check the size Telegram reported before downloading anything.
      if ((message.media.sizeBytes ?? 0) > maxBytes) throw new MediaTooLargeError(`media is ${message.media.sizeBytes} bytes`)
      const file = await client.downloadFile(message.media.id)
      if (file.data.length > maxBytes) throw new MediaTooLargeError(`media is ${file.data.length} bytes`)
      return { data: file.data, mimeType: message.media.mimeType ?? 'audio/ogg' }
    },
    async closeApproval(message, outcome) {
      // Best effort: the decision is already recorded, and these only tidy the chat.
      if (message.callbackId) await client.answerCallbackQuery(message.callbackId, outcome).catch(() => {})
      await client.removeButtons(message.from, message.platformMessageId).catch(() => {})
    },
  }
  return channel
}
