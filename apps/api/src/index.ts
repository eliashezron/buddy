import { readFileSync } from 'node:fs'
import { createLogger, envSchema, loadConfigOrExit } from '@wa/core'
import { createInboundQueue } from './queue.js'
import { buildServer } from './server.js'

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
})

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
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
