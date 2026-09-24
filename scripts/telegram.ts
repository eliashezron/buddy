/**
 * pnpm telegram <command>
 *
 *   me                    Check the bot token: prints the bot's id and @username.
 *   set-webhook <url>     Point Telegram at https://<host>/telegram/webhook with our secret.
 *                         Pass the public base URL (e.g. your tunnel); the path is added.
 *   info                  Show the current webhook, pending updates and the last delivery error.
 *   delete-webhook        Remove the webhook (needed before TELEGRAM_MODE=polling works).
 */
import { createLogger } from '@wa/core'
import { BotApiClient } from '@wa/telegram'

const [command, arg] = process.argv.slice(2)
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  process.stderr.write('TELEGRAM_BOT_TOKEN is not set (create a bot with @BotFather and put the token in .env)\n')
  process.exit(1)
}
const client = new BotApiClient({ token, logger: createLogger({ name: 'telegram-cli', level: 'warn' }) })
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

switch (command) {
  case 'me': {
    const me = await client.getMe()
    print({ id: me.id, username: `@${me.username}` })
    break
  }
  case 'set-webhook': {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET
    if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not set')
    if (!arg) throw new Error('usage: pnpm telegram set-webhook https://<public-host>')
    const url = new URL(arg)
    if (url.protocol !== 'https:') throw new Error('Telegram requires an https webhook URL')
    if (!url.pathname.endsWith('/telegram/webhook')) url.pathname = `${url.pathname.replace(/\/$/, '')}/telegram/webhook`
    await client.setWebhook(url.toString(), secret)
    print({ webhook: url.toString(), allowed_updates: ['message'] })
    break
  }
  case 'info': {
    const info = await client.getWebhookInfo()
    print({ url: info.url || '(none: polling or unset)', pending: info.pending_update_count, lastError: info.last_error_message ?? null })
    break
  }
  case 'delete-webhook':
    await client.deleteWebhook()
    print({ webhook: null })
    break
  default:
    process.stderr.write('usage: pnpm telegram <me | set-webhook <url> | info | delete-webhook>\n')
    process.exit(2)
}
