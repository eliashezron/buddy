import Fastify, { LogController } from 'fastify'
import type { ChannelEvent, Logger } from '@wa/core'
import { telegramRoutes } from './telegram.js'
import { webhookRoutes } from './webhook.js'

export interface ServerDeps {
  logger: Logger
  version: string
  appSecret: string
  verifyToken: string
  enqueue: (events: ChannelEvent[]) => Promise<void>
  /** Set to accept Telegram webhooks (webhook mode only). */
  telegramSecretToken?: string
}

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Default request logs include the query string, which carries hub.verify_token.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
  })

  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    )
  })

  app.get('/health', async () => ({ ok: true, version: deps.version }))

  app.register(webhookRoutes, { appSecret: deps.appSecret, verifyToken: deps.verifyToken, enqueue: deps.enqueue })
  if (deps.telegramSecretToken) {
    app.register(telegramRoutes, { secretToken: deps.telegramSecretToken, enqueue: deps.enqueue })
  }

  return app
}
