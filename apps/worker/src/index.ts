import Anthropic from '@anthropic-ai/sdk'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { createLogger, envSchema, loadConfigOrExit, QUEUES, type Channel, type ChannelEvent, type ChannelName } from '@wa/core'
import { createDb, createRepo } from '@wa/db'
import { createTools } from '@wa/tools'
import { BotApiClient, createTelegramChannel } from '@wa/telegram'
import { CloudApiClient, createWhatsAppChannel } from '@wa/whatsapp'
import { createInboundHandler } from './inbound.js'

const config = loadConfigOrExit(envSchema)
const logger = createLogger({ name: 'worker', level: config.LOG_LEVEL })

const { db, close: closeDb } = createDb(config.DATABASE_URL)
const repo = createRepo(db)
// Vendor must be on zero-retention / no-training terms (CLAUDE.md).
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 })
const channels: Partial<Record<ChannelName, Channel>> = {
  whatsapp: createWhatsAppChannel({
    client: new CloudApiClient({
      accessToken: config.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      graphApiVersion: config.GRAPH_API_VERSION,
      logger: logger.child({ component: 'graph' }),
    }),
    getLastInboundAt: (waId) => repo.getLastInboundAt('whatsapp', waId),
    onTypingError: (err) => logger.warn({ err }, 'whatsapp markRead failed'),
  }),
}
if (config.TELEGRAM_BOT_TOKEN) {
  channels.telegram = createTelegramChannel({
    client: new BotApiClient({ token: config.TELEGRAM_BOT_TOKEN, logger: logger.child({ component: 'telegram' }) }),
    onTypingError: (err) => logger.warn({ err }, 'telegram typing failed'),
  })
}

const handle = createInboundHandler({
  repo,
  channels,
  createMessage: (params, opts) => anthropic.beta.messages.create(params, opts),
  model: config.AGENT_MODEL,
  tools: createTools({ anthropic, searchModel: config.SEARCH_MODEL }),
  logger,
  defaultTimezone: config.DEFAULT_TIMEZONE,
})

// BullMQ workers need maxRetriesPerRequest: null (blocking commands).
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })

const inbound = new Worker<ChannelEvent>(
  QUEUES.inbound,
  async (job) => {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
    await handle(job.data, { finalAttempt })
  },
  { connection, concurrency: 8 },
)
inbound.on('failed', (job, err) => logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'inbound job failed'))
inbound.on('error', (err) => logger.error({ err }, 'inbound worker error'))

// Retention: drop message bodies after MESSAGE_RETENTION_DAYS (PRD, security and privacy).
const maintenanceQueue = new Queue(QUEUES.maintenance, { connection })
await maintenanceQueue.upsertJobScheduler('purge-message-bodies', { every: 6 * 60 * 60_000 }, { name: 'purge' })
const maintenance = new Worker(
  QUEUES.maintenance,
  async () => {
    const cutoff = new Date(Date.now() - config.MESSAGE_RETENTION_DAYS * 24 * 60 * 60_000)
    const purged = await repo.purgeBodiesBefore(cutoff)
    logger.info({ purged }, 'retention purge done')
  },
  { connection, concurrency: 1 },
)
maintenance.on('error', (err) => logger.error({ err }, 'maintenance worker error'))

logger.info({ queues: [QUEUES.inbound, QUEUES.maintenance], channels: Object.keys(channels), model: config.AGENT_MODEL }, 'worker started')

/** Stay under the usual SIGTERM→SIGKILL window of hosting platforms (often 30 s). */
const SHUTDOWN_GRACE_MS = 15_000

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, 'shutting down; waiting for active jobs')
  const closing = Promise.all([inbound.close(), maintenance.close()]).then(() => false)
  const timedOut = await Promise.race([
    closing,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS).unref()),
  ])
  if (timedOut) {
    // Platforms SIGKILL shortly after SIGTERM. Unfinished jobs return to the queue as
    // stalled and are retried; the handler is idempotent (dedup on completed runs).
    logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'active jobs still running; forcing close, they will be retried')
    await Promise.all([inbound.close(true), maintenance.close(true)])
  }
  await maintenanceQueue.close()
  connection.disconnect()
  await closeDb()
  logger.info('worker stopped')
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
