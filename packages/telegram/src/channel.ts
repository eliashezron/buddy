import { splitText, type Channel, type InboundMessage } from '@wa/core'
import { TelegramApiError, type TelegramClient } from './client.js'
import { MAX_TEXT_LENGTH, toPlainText, toTelegramHtml } from './format.js'

/** Telegram's "typing…" lasts ~5 s, so it's refreshed until the reply is sent. */
const TYPING_REFRESH_MS = 4_500

export interface TelegramChannelDeps {
  client: TelegramClient
  onTypingError?: (err: unknown) => void
}

/** Telegram as a `Channel`. No service window: a bot may reply any time the user has started it. */
export function createTelegramChannel({ client, onTypingError = () => {} }: TelegramChannelDeps): Channel {
  return {
    name: 'telegram',
    async sendText(chatId, markdown) {
      // Returned ids are `<chatId>:<message_id>`, matching inbound ids (message_id is per chat).
      const ids: string[] = []
      // Split the Markdown before converting, so no chunk cuts through an HTML tag.
      for (const chunk of splitText(markdown, MAX_TEXT_LENGTH)) {
        try {
          ids.push(`${chatId}:${(await client.sendMessage(chatId, toTelegramHtml(chunk), { html: true })).messageId}`)
        } catch (err) {
          const badMarkup = err instanceof TelegramApiError && err.errorCode === 400 && /parse entities/i.test(err.description)
          if (!badMarkup) throw err
          ids.push(`${chatId}:${(await client.sendMessage(chatId, toPlainText(chunk))).messageId}`)
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
  }
}
