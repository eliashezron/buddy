import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '@wa/core'
import type { ChannelEvent, QueueEvent } from '@wa/core'
import { signBody } from '@wa/whatsapp'
import { buildServer } from '../src/server.js'
import { jobIdFor } from '../src/queue.js'
import { registerRawBodyParser } from '../src/webhook.js'

const SECRET = 'test-app-secret'
const VERIFY = 'test-verify-token'

function fixtureBody(name: string): string {
  const file = path.resolve(import.meta.dirname, `../../../fixtures/${name}.json`)
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(file, 'utf8'))
  return JSON.stringify(payload)
}

describe('api', () => {
  let enqueued: QueueEvent[][]
  let app: ReturnType<typeof buildServer>
  let failEnqueue = false

  beforeEach(() => {
    enqueued = []
    failEnqueue = false
    app = buildServer({
      logger: createLogger({ name: 'test', level: 'silent' }),
      version: '9.9.9',
      appSecret: SECRET,
      verifyToken: VERIFY,
      enqueue: async (events) => {
        if (failEnqueue) throw new Error('redis down')
        enqueued.push(events)
      },
    })
  })
  afterEach(() => app.close())

  it('GET /health returns ok and version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, version: '9.9.9' })
  })

  describe('GET /webhook (verification handshake)', () => {
    it('echoes the challenge as plain text', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/^text\/plain/)
      expect(res.body).toBe('12345')
    })

    it('rejects a wrong token', async () => {
      const res = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' })
      expect(res.statusCode).toBe(403)
    })
  })

  describe('POST /webhook', () => {
    const post = (body: string, signature?: string) =>
      app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
        payload: body,
      })

    it('verifies the signature over the raw body and enqueues events', async () => {
      const body = fixtureBody('book-meeting')
      const res = await post(body, signBody(body, SECRET))
      expect(res.statusCode).toBe(200)
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]![0]).toMatchObject({ kind: 'message', message: { id: 'wamid.TEST_BOOK_MEETING_0001' } })
    })

    it('verifies against exact bytes, including whitespace a re-serialiser would drop', async () => {
      const body = JSON.stringify(JSON.parse(fixtureBody('status-update')), null, 3)
      const res = await post(body, signBody(body, SECRET))
      expect(res.statusCode).toBe(200)
      expect(enqueued[0]![0]!.kind).toBe('status')
    })

    it('rejects missing and invalid signatures without enqueueing', async () => {
      const body = fixtureBody('book-meeting')
      expect((await post(body)).statusCode).toBe(401)
      expect((await post(body, signBody(body, 'wrong'))).statusCode).toBe(401)
      expect((await post(body.replace('Amina', 'Bob'), signBody(body, SECRET))).statusCode).toBe(401)
      expect(enqueued).toEqual([])
    })

    it('acks a signed but unparseable body so Meta does not retry forever', async () => {
      const body = '{"object":"page"}'
      const res = await post(body, signBody(body, SECRET))
      expect(res.statusCode).toBe(200)
      expect(enqueued).toEqual([])
    })

    it('returns 500 when enqueue fails, so Meta redelivers', async () => {
      failEnqueue = true
      const body = fixtureBody('book-meeting')
      expect((await post(body, signBody(body, SECRET))).statusCode).toBe(500)
    })

    it('answers well under a second', async () => {
      const body = fixtureBody('voice-note')
      const start = performance.now()
      await post(body, signBody(body, SECRET))
      expect(performance.now() - start).toBeLessThan(1000)
    })
  })

  it('keeps the raw-body parser scoped to /webhook', async () => {
    app.post('/echo', async (req) => ({ isBuffer: Buffer.isBuffer(req.body), body: req.body }))
    app.register(async (scope) => {
      registerRawBodyParser(scope)
      scope.post('/scoped', async (req) => ({ isBuffer: Buffer.isBuffer(req.body) }))
    })
    const outside = await app.inject({ method: 'POST', url: '/echo', payload: { a: 1 } })
    expect(outside.json()).toEqual({ isBuffer: false, body: { a: 1 } })
    const inside = await app.inject({ method: 'POST', url: '/scoped', payload: { a: 1 } })
    expect(inside.json()).toEqual({ isBuffer: true })
  })
})

describe('jobIdFor', () => {
  it('is stable per message id and distinguishes status transitions', () => {
    const msg = (id: string): ChannelEvent => ({
      kind: 'message',
      message: { channel: 'whatsapp', id, from: 'x', timestamp: 1, type: 'text', platformMessageId: id },
    })
    const st = (status: string): ChannelEvent => ({
      kind: 'status',
      status: { channel: 'whatsapp', id: 'wamid.A', status, timestamp: 1, recipientId: 'x', errorCodes: [] },
    })
    expect(jobIdFor(msg('wamid.A'))).toBe(jobIdFor(msg('wamid.A')))
    expect(jobIdFor(msg('wamid.A'))).not.toBe(jobIdFor(msg('wamid.B')))
    expect(jobIdFor(st('sent'))).not.toBe(jobIdFor(st('delivered')))
    expect(jobIdFor(msg('wamid.A'))).not.toContain(':')
  })
})
