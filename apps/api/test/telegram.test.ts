import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, type ChannelEvent, type QueueEvent } from '@wa/core'
import { buildServer } from '../src/server.js'
import { registerTelegramWebhook, startTelegramPoller } from '../src/telegram.js'

const SECRET = 'tg-secret-0123456789-abcdefghijklmnop'
const logger = createLogger({ name: 'test', level: 'silent' })

function update(name: string): Record<string, unknown> {
  const file = path.resolve(import.meta.dirname, `../../../fixtures/${name}.json`)
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(file, 'utf8'))
  return payload
}

function server(opts: { telegram: boolean }) {
  const enqueued: QueueEvent[][] = []
  const app = buildServer({
    logger,
    version: '1',
    appSecret: 'wa',
    verifyToken: 'wa',
    enqueue: async (events) => void enqueued.push(events),
    ...(opts.telegram ? { telegramSecretToken: SECRET } : {}),
  })
  return { app, enqueued }
}

describe('POST /telegram/webhook', () => {
  let app: ReturnType<typeof buildServer>
  afterEach(() => app?.close())

  it('accepts an update carrying the secret header and enqueues it', async () => {
    const s = server({ telegram: true })
    app = s.app
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: update('telegram-text'),
    })
    expect(res.statusCode).toBe(200)
    expect(s.enqueued[0]?.[0]).toMatchObject({ kind: 'message', message: { channel: 'telegram', id: '555000111:41' } })
  })

  it('rejects a missing or wrong secret without enqueueing', async () => {
    const s = server({ telegram: true })
    app = s.app
    for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'wrong' }]) {
      const res = await app.inject({ method: 'POST', url: '/telegram/webhook', headers, payload: update('telegram-text') })
      expect(res.statusCode).toBe(401)
    }
    expect(s.enqueued).toEqual([])
  })

  it('acks group messages without enqueueing (the bot never reads groups)', async () => {
    const s = server({ telegram: true })
    app = s.app
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: update('telegram-group'),
    })
    expect(res.statusCode).toBe(200)
    expect(s.enqueued).toEqual([])
  })

  it('does not exist when Telegram webhooks are not configured', async () => {
    app = server({ telegram: false }).app
    expect((await app.inject({ method: 'POST', url: '/telegram/webhook', payload: {} })).statusCode).toBe(404)
  })
})

describe('Telegram poller', () => {
  it('deletes any webhook, enqueues updates and advances the offset only after enqueue succeeds', async () => {
    const offsets: number[] = []
    const batches = [[update('telegram-text'), update('telegram-group')], [update('telegram-start')]]
    let failOnce = true
    const enqueued: ChannelEvent[][] = []
    let deleted = false
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    const poller = startTelegramPoller({
      logger,
      retryDelayMs: 1,
      client: {
        getWebhookInfo: async () => ({ url: '', pending_update_count: 0 }),
        deleteWebhook: async () => void (deleted = true),
        getUpdates: async (offset: number, _t: number, signal?: AbortSignal) => {
          offsets.push(offset)
          if (offsets.length === 1) return batches[0]!
          if (offsets.length === 2) return batches[0]! // redelivered after the failed enqueue
          if (offsets.length === 3) return batches[1]!
          resolveDone()
          return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        },
      } as never,
      enqueue: async (events) => {
        if (failOnce) {
          failOnce = false
          throw new Error('redis down')
        }
        enqueued.push(events)
      },
    })
    await done
    await poller.stop()
    expect(deleted).toBe(true)
    expect(offsets).toEqual([0, 0, 900000006, 900000003])
    expect(enqueued.map((e) => e[0]?.kind === 'message' && e[0].message.id)).toEqual(['555000111:41', '555000111:40'])
  })
})

describe('Telegram poller safety', () => {
  it('refuses to poll (and leaves the webhook alone) when a webhook is registered', async () => {
    let deleted = false
    let polled = false
    const poller = startTelegramPoller({
      logger,
      client: {
        getWebhookInfo: async () => ({ url: 'https://buddy-api.onrender.com/telegram/webhook', pending_update_count: 0 }),
        deleteWebhook: async () => void (deleted = true),
        getUpdates: async () => ((polled = true), []),
      } as never,
      enqueue: async () => {},
    })
    await poller.stop()
    expect(deleted).toBe(false)
    expect(polled).toBe(false)
  })

  it('takes over only when explicitly allowed', async () => {
    let deleted = false
    let resolvePolled!: () => void
    const polled = new Promise<void>((r) => (resolvePolled = r))
    const poller = startTelegramPoller({
      logger,
      takeover: true,
      client: {
        getWebhookInfo: async () => ({ url: 'https://buddy-api.onrender.com/telegram/webhook', pending_update_count: 0 }),
        deleteWebhook: async () => void (deleted = true),
        getUpdates: async (_o: number, _t: number, signal?: AbortSignal) => {
          resolvePolled()
          return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        },
      } as never,
      enqueue: async () => {},
    })
    await polled
    await poller.stop()
    expect(deleted).toBe(true)
  })
})

describe('registerTelegramWebhook', () => {
  it('registers <base>/telegram/webhook with the secret', async () => {
    const calls: [string, string][] = []
    const ok = await registerTelegramWebhook({
      client: { setWebhook: async (url: string, secret: string) => void calls.push([url, secret]) },
      baseUrl: 'https://buddy-api.onrender.com/',
      secretToken: SECRET,
      logger,
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([['https://buddy-api.onrender.com/telegram/webhook', SECRET]])
  })

  it('logs and carries on when Telegram rejects it', async () => {
    const ok = await registerTelegramWebhook({
      client: { setWebhook: async () => { throw new Error('bad webhook: HTTPS url must be provided') } },
      baseUrl: 'https://x.example',
      secretToken: SECRET,
      logger,
    })
    expect(ok).toBe(false)
  })
})
