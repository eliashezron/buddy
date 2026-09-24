import { readFileSync } from 'node:fs'
import { createLogger, envSchema, loadConfigOrExit } from '@wa/core'
import { BotApiClient } from '@wa/telegram'
import { createInboundQueue } from './queue.js'
import { buildServer } from './server.js'
import { registerTelegramWebhook, startTelegramPoller } from './telegram.js'

const config = loadConfigOrExit(envSchema)
const logger = createLogger({ name: 'api', level: config.LOG_LEVEL })
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

const queue = createInboundQueue(config.REDIS_URL)
const app = buildServer({
  logger,
  version,
  appSecret: config.WHATSAPP_APP_SECRET,
  verifyToken: config.WHATSAPP_VERIFY_TOKEN,
  enqueue: queue.enqueue,
  ...(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_MODE === 'webhook' && config.TELEGRAM_WEBHOOK_SECRET
    ? { telegramSecretToken: config.TELEGRAM_WEBHOOK_SECRET }
    : {}),
})

const telegram = config.TELEGRAM_BOT_TOKEN
  ? new BotApiClient({ token: config.TELEGRAM_BOT_TOKEN, logger: logger.child({ component: 'telegram' }) })
  : null

const poller =
  telegram && config.TELEGRAM_MODE === 'polling'
    ? startTelegramPoller({
        client: telegram,
        enqueue: queue.enqueue,
        logger: logger.child({ component: 'telegram-poller' }),
        takeover: config.TELEGRAM_POLLING_TAKEOVER,
      })
    : null

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
  await poller?.stop()
  await app.close()
  await queue.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ port: config.PORT, host: config.HOST })
} catch (err) {
  logger.fatal({ err }, 'failed to start')
  process.exit(1)
}

// Webhook mode with a known public URL (Render sets RENDER_EXTERNAL_URL): register
// ourselves with Telegram, only after we're listening so the first update lands.
const publicUrl = config.PUBLIC_BASE_URL ?? config.RENDER_EXTERNAL_URL
if (telegram && config.TELEGRAM_MODE === 'webhook' && config.TELEGRAM_WEBHOOK_SECRET) {
  if (publicUrl) {
    await registerTelegramWebhook({
      client: telegram,
      baseUrl: publicUrl,
      secretToken: config.TELEGRAM_WEBHOOK_SECRET,
      logger: logger.child({ component: 'telegram' }),
    })
  } else {
    logger.warn('telegram webhook mode without PUBLIC_BASE_URL: register it with `pnpm telegram set-webhook <url>`')
  }
}
