import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalCipher, createLogger, type QueueEvent } from '@wa/core'
import { createConnectLink, createGoogleOAuth, createMemoryConnectorRepo, fakeGoogleFetch, fakeIdToken } from '@wa/connectors'
import { buildServer } from '../src/server.js'

const logger = createLogger({ name: 'test', level: 'silent' })

function setup() {
  const mem = createMemoryConnectorRepo()
  const fetchStub = fakeGoogleFetch({
    token: () => ({
      status: 200,
      json: {
        access_token: 'ya29.a',
        expires_in: 3600,
        refresh_token: '1//r',
        scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly',
        id_token: fakeIdToken('elias@example.com'),
      },
    }),
  })
  const google = {
    repo: mem.repo,
    cipher: createLocalCipher(randomBytes(32).toString('base64')),
    oauth: createGoogleOAuth({ clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost:3000/oauth/google/callback', fetch: fetchStub.impl }),
    logger,
  }
  const enqueued: QueueEvent[] = []
  const app = buildServer({ logger, version: '1', appSecret: 'x', verifyToken: 'x', enqueue: async (e) => void enqueued.push(...e), google })
  const link = () => createConnectLink({ ...google, baseUrl: 'http://localhost:3000' }, { userId: 'u1', needed: ['calendar.read'], triggerMessageId: 'm1' })
  return { app, enqueued, link, mem }
}

describe('/oauth/google', () => {
  let app: ReturnType<typeof buildServer>
  afterEach(() => app?.close())

  it('start: redirects a live link to Google without leaking it via Referer', async () => {
    const t = setup()
    app = t.app
    const { url } = await t.link()
    const res = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('start: explains an unknown or expired link', async () => {
    const t = setup()
    app = t.app
    const res = await app.inject({ method: 'GET', url: '/oauth/google/start?s=not-a-real-token' })
    expect(res.statusCode).toBe(410)
    expect(res.body).toContain('This link has expired')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
  })

  it('callback: stores the connection, queues the resume event, and escapes the account in HTML', async () => {
    const t = setup()
    app = t.app
    const state = new URL((await t.link()).url).searchParams.get('s')!
    const res = await app.inject({ method: 'GET', url: `/oauth/google/callback?state=${state}&code=abc` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Google Calendar connected')
    expect(res.body).toContain('elias@example.com')
    expect(t.mem.connections.size).toBe(1)
    expect(t.enqueued).toEqual([
      expect.objectContaining({ kind: 'connection', outcome: 'connected', userId: 'u1', triggerMessageId: 'm1', missing: [], account: 'elias@example.com' }),
    ])

    const again = await app.inject({ method: 'GET', url: `/oauth/google/callback?state=${state}&code=abc` })
    expect(again.statusCode).toBe(410)
    expect(t.enqueued).toHaveLength(1)
  })

  it('callback: a denied consent queues a "denied" event and stores nothing', async () => {
    const t = setup()
    app = t.app
    const state = new URL((await t.link()).url).searchParams.get('s')!
    const res = await app.inject({ method: 'GET', url: `/oauth/google/callback?state=${state}&error=access_denied` })
    expect(res.body).toContain('Nothing was connected')
    expect(t.mem.connections.size).toBe(0)
    expect(t.enqueued[0]).toMatchObject({ kind: 'connection', outcome: 'denied' })
  })

  it('does not exist when Google is not configured', async () => {
    app = buildServer({ logger, version: '1', appSecret: 'x', verifyToken: 'x', enqueue: async () => {} })
    expect((await app.inject({ method: 'GET', url: '/oauth/google/start?s=x' })).statusCode).toBe(404)
  })
})
