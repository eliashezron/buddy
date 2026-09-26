import Anthropic from '@anthropic-ai/sdk'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import {
  createLocalCipher,
  createLogger,
  envSchema,
  loadConfigOrExit,
  publicBaseUrl,
  QUEUES,
  type Channel,
  type ChannelName,
  type QueueEvent,
} from '@wa/core'
import { createConnectLink, createGoogleOAuth, googleConnectionManager, googleCredentials } from '@wa/connectors'
import { createDb, createRepo } from '@wa/db'
import { createTools } from '@wa/tools'
import { BotApiClient, botIdFromToken, createTelegramChannel } from '@wa/telegram'
import { CloudApiClient, createWhatsAppChannel } from '@wa/whatsapp'
import { createResponsesMessage, type CreateMessage } from '@wa/agent'
import { createElevenLabsSpeechToText, createElevenLabsTextToSpeech } from '@wa/speech'
import { createInboundHandler, type Connectors } from './inbound.js'

const config = loadConfigOrExit(envSchema)
const logger = createLogger({ name: 'worker', level: config.LOG_LEVEL })

const { db, close: closeDb } = createDb(config.DATABASE_URL)
const repo = createRepo(db)
// Vendor must be on zero-retention / no-training terms (CLAUDE.md).
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? 'unused-with-opencode', timeout: 90_000, maxRetries: 2 })
// The agent's model. LLM_PROVIDER=opencode (development only, refused in production by
// config validation) runs it on an OpenAI Responses model such as gpt-6-luna instead.
if (config.LLM_PROVIDER === 'opencode' && config.NODE_ENV === 'production') {
  // CLAUDE.md "Non-negotiables": owner's exception of 2026-09-26. Never silent.
  logger.warn(
    { provider: 'opencode', model: config.AGENT_MODEL },
    'production model vendor is not zero-retention (30-day retention); owner exception, revisit before WhatsApp goes live',
  )
}
const createMessage: CreateMessage =
  config.LLM_PROVIDER === 'opencode'
    ? createResponsesMessage({ apiKey: config.OPENCODE_API_KEY!, baseUrl: config.OPENCODE_BASE_URL })
    : (params, opts) => anthropic.beta.messages.create(params, opts)
// Voice notes: on when an ElevenLabs key is configured.
const speech = config.ELEVENLABS_API_KEY ? createElevenLabsSpeechToText({ apiKey: config.ELEVENLABS_API_KEY, model: config.STT_MODEL }) : undefined
// Voice replies: same key.
const tts = config.ELEVENLABS_API_KEY ? createElevenLabsTextToSpeech({ apiKey: config.ELEVENLABS_API_KEY, voiceId: config.TTS_VOICE_ID }) : undefined
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
    botId: botIdFromToken(config.TELEGRAM_BOT_TOKEN),
    onTypingError: (err) => logger.warn({ err }, 'telegram typing failed'),
  })
}

// Google connectors (Calendar, Gmail): only when configured. Config validation guarantees
// the secret, encryption key and public URL exist whenever the client id does.
let connectors: Connectors | undefined
const baseUrl = publicBaseUrl(config)
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.TOKEN_ENCRYPTION_KEY && baseUrl) {
  const googleDeps = {
    repo,
    // Local key. CLAUDE.md requires a KMS-backed cipher before production (docs/connectors.md).
    cipher: createLocalCipher(config.TOKEN_ENCRYPTION_KEY),
    oauth: createGoogleOAuth({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      redirectUri: `${baseUrl}/oauth/google/callback`,
    }),
    logger: logger.child({ component: 'google' }),
  }
  connectors = {
    forUser: (userId) => ({
      credentials: googleCredentials(googleDeps, userId),
      connections: googleConnectionManager(googleDeps, userId),
    }),
    connectLink: (input) => createConnectLink({ ...googleDeps, baseUrl }, input),
  }
}

const handle = createInboundHandler({
  repo,
  channels,
  createMessage,
  model: config.AGENT_MODEL,
  tools: createTools({
    anthropic,
    searchModel: config.SEARCH_MODEL,
    google: Boolean(connectors),
    // With the development provider, web search goes through OpenCode as well: no Anthropic calls at all.
    ...(config.LLM_PROVIDER === 'opencode'
      ? { responsesSearch: { apiKey: config.OPENCODE_API_KEY!, baseUrl: config.OPENCODE_BASE_URL, model: config.AGENT_MODEL } }
      : {}),
  }),
  logger,
  defaultTimezone: config.DEFAULT_TIMEZONE,
  ...(connectors ? { connectors } : {}),
  ...(speech ? { speech } : {}),
  ...(tts ? { tts } : {}),
})

// BullMQ workers need maxRetriesPerRequest: null (blocking commands).
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })

const inbound = new Worker<QueueEvent>(
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

logger.info({ queues: [QUEUES.inbound, QUEUES.maintenance], channels: Object.keys(channels), google: Boolean(connectors), model: config.AGENT_MODEL, provider: config.LLM_PROVIDER, voice: Boolean(speech) }, 'worker started')

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
