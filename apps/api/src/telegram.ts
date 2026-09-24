import type { FastifyPluginAsync } from 'fastify'
import type { ChannelEvent, Logger } from '@wa/core'
import { InvalidUpdateError, parseTelegramUpdate, verifySecretToken, type BotApiClient } from '@wa/telegram'

export interface TelegramRouteOptions {
  secretToken: string
  enqueue: (events: ChannelEvent[]) => Promise<void>
}

/** verify secret header → parse → enqueue → 200. Same shape as the WhatsApp webhook. */
export const telegramRoutes: FastifyPluginAsync<TelegramRouteOptions> = async (app, opts) => {
  app.post('/telegram/webhook', async (req, reply) => {
    if (!verifySecretToken(req.headers['x-telegram-bot-api-secret-token'], opts.secretToken)) {
      req.log.warn('telegram webhook secret rejected')
      return reply.code(401).send()
    }
    let events: ChannelEvent[]
    try {
      const result = parseTelegramUpdate(req.body)
      events = result.events
      if (result.skipped.length) req.log.info({ skipped: result.skipped }, 'telegram update skipped')
    } catch (err) {
      if (!(err instanceof InvalidUpdateError)) throw err
      // Authenticated but unparseable: redelivery won't fix it, so ack.
      req.log.error({ reason: err.message }, 'telegram update could not be parsed')
      return reply.code(200).send()
    }
    if (events.length) await opts.enqueue(events)
    req.log.info({ messageCount: events.length }, 'telegram update accepted')
    return reply.code(200).send()
  })
}

type PollingClient = Pick<BotApiClient, 'getUpdates' | 'deleteWebhook' | 'getWebhookInfo'>

/**
 * Webhook mode: point Telegram at this deployment on every boot. Idempotent, and it
 * re-sends the secret token, so rotating TELEGRAM_WEBHOOK_SECRET takes effect on redeploy.
 */
export async function registerTelegramWebhook(deps: {
  client: Pick<BotApiClient, 'setWebhook'>
  baseUrl: string
  secretToken: string
  logger: Logger
}): Promise<boolean> {
  const url = `${deps.baseUrl.replace(/\/$/, '')}/telegram/webhook`
  try {
    await deps.client.setWebhook(url, deps.secretToken)
    deps.logger.info({ url }, 'telegram webhook registered')
    return true
  } catch (err) {
    // Keep serving: WhatsApp and /health don't depend on this.
    deps.logger.error({ err, url }, 'telegram webhook registration failed')
    return false
  }
}

/**
 * Long polling for local development: no public URL or tunnel needed. Advances the
 * offset only after a successful enqueue, so a Redis failure re-fetches the batch
 * (and the queue's job ids absorb anything enqueued twice).
 */
export function startTelegramPoller(deps: {
  client: PollingClient
  enqueue: (events: ChannelEvent[]) => Promise<void>
  logger: Logger
  timeoutSec?: number
  retryDelayMs?: number
  /** Delete an existing webhook and poll anyway. */
  takeover?: boolean
}) {
  const controller = new AbortController()
  const { signal } = controller
  let offset = 0

  async function loop() {
    // getUpdates is refused while a webhook is set, and deleting someone else's webhook
    // (e.g. production's, from a laptop sharing the bot token) takes that bot offline.
    const { url } = await deps.client.getWebhookInfo()
    if (url && !deps.takeover) {
      deps.logger.error(
        { webhookHost: new URL(url).host },
        'telegram polling NOT started: a webhook is registered for this bot. Use a separate dev bot, ' +
          'or set TELEGRAM_POLLING_TAKEOVER=true to take it over (this disconnects that deployment).',
      )
      return
    }
    if (url) deps.logger.warn({ webhookHost: new URL(url).host }, 'taking over telegram bot from registered webhook')
    await deps.client.deleteWebhook()
    deps.logger.info('telegram polling started')
    while (!signal.aborted) {
      try {
        const updates = await deps.client.getUpdates(offset, deps.timeoutSec ?? 25, signal)
        for (const update of updates) {
          const updateId = (update as { update_id?: unknown }).update_id
          try {
            const { events, skipped } = parseTelegramUpdate(update)
            if (skipped.length) deps.logger.info({ skipped }, 'telegram update skipped')
            if (events.length) await deps.enqueue(events)
          } catch (err) {
            if (!(err instanceof InvalidUpdateError)) throw err
            deps.logger.error({ reason: err.message }, 'telegram update could not be parsed')
          }
          if (typeof updateId === 'number') offset = updateId + 1
        }
      } catch (err) {
        if (signal.aborted) break
        deps.logger.warn({ err }, 'telegram polling failed, retrying')
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 3_000))
      }
    }
  }

  const done = loop().catch((err: unknown) => deps.logger.error({ err }, 'telegram poller stopped'))
  return {
    async stop() {
      controller.abort()
      await done
    },
  }
}
