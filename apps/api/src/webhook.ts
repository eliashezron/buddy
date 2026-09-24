import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { InvalidPayloadError, parseWebhook, verifySignature, type WebhookEvent } from '@wa/whatsapp'

export interface WebhookOptions {
  appSecret: string
  verifyToken: string
  /** Must be fast (Redis add). Throwing makes us return 500 so Meta redelivers. */
  enqueue: (events: WebhookEvent[]) => Promise<void>
}

/**
 * Inside this plugin's scope only, JSON bodies arrive as the untouched Buffer.
 * Nothing here parses JSON until the signature over those exact bytes checks out.
 */
export function registerRawBodyParser(scope: FastifyInstance) {
  scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  )
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export const webhookRoutes: FastifyPluginAsync<WebhookOptions> = async (app, opts) => {
  registerRawBodyParser(app)

  // Verification handshake (whatsapp-notes.md §4.1): echo hub.challenge as plain text.
  app.get<{ Querystring: Record<string, string | undefined> }>('/webhook', async (req, reply) => {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe' && token && challenge && safeEqual(token, opts.verifyToken)) {
      return reply.type('text/plain').send(challenge)
    }
    req.log.warn('webhook verification rejected')
    return reply.code(403).send()
  })

  // verify → parse → enqueue → 200. No model calls, no DB work, nothing slow.
  app.post('/webhook', async (req, reply) => {
    const raw = req.body
    if (!Buffer.isBuffer(raw)) return reply.code(415).send()

    const signature = req.headers['x-hub-signature-256']
    if (!verifySignature(raw, typeof signature === 'string' ? signature : undefined, opts.appSecret)) {
      req.log.warn({ bytes: raw.length }, 'webhook signature rejected')
      return reply.code(401).send()
    }

    let events: WebhookEvent[]
    try {
      const result = parseWebhook(JSON.parse(raw.toString('utf8')))
      events = result.events
      if (result.skipped.length) req.log.info({ skipped: result.skipped }, 'webhook changes skipped')
    } catch (err) {
      // Signed by Meta but unparseable: redelivery won't fix it, so ack and alert.
      const reason = err instanceof InvalidPayloadError ? err.message : 'invalid JSON'
      req.log.error({ reason }, 'signed webhook could not be parsed')
      return reply.code(200).send()
    }

    if (events.length) await opts.enqueue(events)
    req.log.info(
      {
        messageCount: events.filter((e) => e.kind === 'message').length,
        statusCount: events.filter((e) => e.kind === 'status').length,
      },
      'webhook accepted',
    )
    return reply.code(200).send()
  })
}
