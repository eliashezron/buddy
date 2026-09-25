import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLocalCipher, createLogger, NeedsConnectionError } from '@wa/core'
import {
  CAPABILITY_SCOPE,
  completeAuthorization,
  createConnectLink,
  createGoogleOAuth,
  createMemoryConnectorRepo,
  fakeGoogleFetch,
  fakeIdToken,
  googleConnectionManager,
  GOOGLE_CAPABILITIES,
  googleCredentials,
  grantedCapabilities,
  startAuthorization,
  tokenContext,
} from '../src/index.js'

const CAL_READ = 'https://www.googleapis.com/auth/calendar.events.readonly'
const CAL_WRITE = 'https://www.googleapis.com/auth/calendar.events'
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly'

function setup(token?: (b: URLSearchParams) => { status: number; json: unknown }) {
  const mem = createMemoryConnectorRepo()
  const fetchStub = fakeGoogleFetch({ ...(token ? { token } : {}) })
  let clock = new Date('2026-09-24T12:00:00Z')
  const deps = {
    repo: mem.repo,
    cipher: createLocalCipher(randomBytes(32).toString('base64')),
    oauth: createGoogleOAuth({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost:3000/oauth/google/callback', fetch: fetchStub.impl }),
    logger: createLogger({ name: 'test', level: 'silent' }),
    now: () => clock,
  }
  return { ...mem, deps, fetchStub, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) }
}

const tokenOf = (url: string) => new URL(url).searchParams.get('s')!

describe('scopes', () => {
  it('maps granted scopes to capabilities; calendar write implies read', () => {
    expect(grantedCapabilities([CAL_WRITE])).toEqual(['calendar.read', 'calendar.write'])
    expect(grantedCapabilities([CAL_READ, GMAIL])).toEqual(['calendar.read', 'gmail.read'])
    expect(grantedCapabilities(['openid', 'email'])).toEqual([])
  })
})

describe('connect link → Google → callback', () => {
  it('offers every Google permission at once, with PKCE, offline access and incremental auth', async () => {
    const t = setup()
    const { url } = await createConnectLink({ ...t.deps, baseUrl: 'http://localhost:3000' }, { userId: 'u1', needed: ['calendar.read'], triggerMessageId: 'm1' })
    expect(url).toMatch(/^http:\/\/localhost:3000\/oauth\/google\/start\?s=[\w-]{43}$/)
    // Only a hash is stored, never the token itself.
    expect([...t.states.keys()][0]).not.toBe(tokenOf(url))

    const google = new URL((await startAuthorization(t.deps, tokenOf(url)))!)
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = google.searchParams
    // The needed one first, then the rest; Google shows a checkbox for each.
    expect(p.get('scope')!.split(' ')).toEqual(['openid', 'email', CAL_READ, ...GOOGLE_CAPABILITIES.filter((c) => c !== 'calendar.read').map((c) => CAPABILITY_SCOPE[c])])
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('include_granted_scopes')).toBe('true')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(p.get('state')).toBe(tokenOf(url))
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/oauth/google/callback')
  })

  it('exchanges the code with the PKCE verifier, stores encrypted tokens, and works exactly once', async () => {
    const t = setup(() => ({
      status: 200,
      json: { access_token: 'ya29.access', expires_in: 3600, refresh_token: '1//refresh', scope: `openid email ${CAL_READ}`, id_token: fakeIdToken('elias@example.com') },
    }))
    const { url } = await createConnectLink({ ...t.deps, baseUrl: 'http://localhost:3000' }, { userId: 'u1', needed: ['calendar.read'], triggerMessageId: 'm1' })
    const state = tokenOf(url)

    const outcome = await completeAuthorization(t.deps, { state, code: 'auth-code' })
    expect(outcome).toEqual({
      kind: 'connected',
      userId: 'u1',
      triggerMessageId: 'm1',
      requested: ['calendar.read', ...GOOGLE_CAPABILITIES.filter((c) => c !== 'calendar.read')],
      needed: ['calendar.read'],
      granted: ['calendar.read'],
      missing: [],
      account: 'elias@example.com',
    })

    const exchange = t.fetchStub.calls[0]!.body
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('auth-code')
    expect(exchange.get('code_verifier')).toMatch(/^[\w-]{43}$/)

    const conn = t.connections.get('u1:google')!
    expect(conn.refreshTokenEnc).not.toContain('refresh')
    expect(t.deps.cipher.decrypt(conn.refreshTokenEnc, tokenContext('u1', 'refresh'))).toBe('1//refresh')

    // Replaying the same callback does nothing.
    expect(await completeAuthorization(t.deps, { state, code: 'auth-code' })).toEqual({ kind: 'invalid' })
    expect(await startAuthorization(t.deps, state)).toBeNull()
  })

  it('only needed permissions count as missing; optional ones the user unticked are fine', async () => {
    const t = setup(() => ({ status: 200, json: { access_token: 'a', expires_in: 3600, refresh_token: 'r', scope: `openid email ${CAL_READ}` } }))
    const ok = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: ['calendar.read'], triggerMessageId: null })
    expect(await completeAuthorization(t.deps, { state: tokenOf(ok.url), code: 'c' })).toMatchObject({ kind: 'connected', granted: ['calendar.read'], missing: [] })
    const short = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: ['calendar.read', 'gmail.read'], triggerMessageId: null })
    expect(await completeAuthorization(t.deps, { state: tokenOf(short.url), code: 'c' })).toMatchObject({ kind: 'connected', missing: ['gmail.read'] })
  })

  it('treats links from before `needed` existed as needing everything they asked for', async () => {
    const t = setup(() => ({ status: 200, json: { access_token: 'a', expires_in: 3600, refresh_token: 'r', scope: `openid email ${CAL_READ}` } }))
    const { url } = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: ['gmail.read'], triggerMessageId: null })
    const row = [...t.states.values()][0]!
    row.capabilities = ['gmail.read']
    row.needed = []
    expect(await completeAuthorization(t.deps, { state: tokenOf(url), code: 'c' })).toMatchObject({ needed: ['gmail.read'], missing: ['gmail.read'] })
  })

  it('keeps the existing refresh token when Google does not send a new one', async () => {
    let n = 0
    const t = setup(() => ({
      status: 200,
      json: n++ === 0
        ? { access_token: 'a1', expires_in: 3600, refresh_token: '1//first', scope: `openid email ${CAL_READ}` }
        : { access_token: 'a2', expires_in: 3600, scope: `openid email ${CAL_READ} ${GMAIL}` },
    }))
    for (const caps of [['calendar.read'], ['gmail.read']] as const) {
      const { url } = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: [...caps], triggerMessageId: null })
      await completeAuthorization(t.deps, { state: tokenOf(url), code: 'c' })
    }
    const conn = t.connections.get('u1:google')!
    expect(conn.scopes).toContain(GMAIL)
    expect(t.deps.cipher.decrypt(conn.refreshTokenEnc, tokenContext('u1', 'refresh'))).toBe('1//first')
  })

  it('handles denial and expiry', async () => {
    const t = setup()
    const a = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: ['gmail.read'], triggerMessageId: 'm9' })
    expect(await completeAuthorization(t.deps, { state: tokenOf(a.url), error: 'access_denied' })).toEqual({
      kind: 'denied',
      userId: 'u1',
      triggerMessageId: 'm9',
      requested: ['gmail.read', ...GOOGLE_CAPABILITIES.filter((c) => c !== 'gmail.read')],
      needed: ['gmail.read'],
    })
    const b = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: ['gmail.read'], triggerMessageId: null })
    t.tick(15 * 60_000 + 1)
    expect(await startAuthorization(t.deps, tokenOf(b.url))).toBeNull()
    expect(await completeAuthorization(t.deps, { state: tokenOf(b.url), code: 'c' })).toEqual({ kind: 'invalid' })
    expect(t.connections.size).toBe(0)
  })
})

describe('googleCredentials', () => {
  async function connected(scope: string, token: (b: URLSearchParams) => { status: number; json: unknown }) {
    let first = true
    const t = setup((b) =>
      first && b.get('grant_type') === 'authorization_code'
        ? ((first = false), { status: 200, json: { access_token: 'ya29.first', expires_in: 3600, refresh_token: '1//r', scope } })
        : token(b),
    )
    const { url } = await createConnectLink({ ...t.deps, baseUrl: 'http://x' }, { userId: 'u1', needed: ['calendar.read'], triggerMessageId: null })
    await completeAuthorization(t.deps, { state: tokenOf(url), code: 'c' })
    return t
  }

  it('needs a connection when nothing is connected', async () => {
    const t = setup()
    await expect(googleCredentials(t.deps, 'u1').accessToken(['calendar.read'])).rejects.toMatchObject({ problem: 'not_connected' })
  })

  it('uses the cached token, then refreshes near expiry', async () => {
    const t = await connected(`openid email ${CAL_READ}`, () => ({ status: 200, json: { access_token: 'ya29.second', expires_in: 3600, scope: CAL_READ } }))
    const creds = googleCredentials(t.deps, 'u1')
    expect(await creds.accessToken(['calendar.read'])).toBe('ya29.first')
    t.tick(3600_000 - 30_000)
    expect(await creds.accessToken(['calendar.read'])).toBe('ya29.second')
    expect(t.fetchStub.calls.at(-1)!.body.get('grant_type')).toBe('refresh_token')
  })

  it('asks for more access when a capability was never granted', async () => {
    const t = await connected(`openid email ${CAL_READ}`, () => ({ status: 500, json: {} }))
    const err = await googleCredentials(t.deps, 'u1').accessToken(['gmail.read']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NeedsConnectionError)
    expect(err).toMatchObject({ problem: 'missing_permission', capabilities: ['gmail.read'] })
  })

  it('forgets a revoked grant and asks to reconnect', async () => {
    const t = await connected(`openid email ${CAL_READ}`, () => ({ status: 400, json: { error: 'invalid_grant' } }))
    t.tick(2 * 3600_000)
    await expect(googleCredentials(t.deps, 'u1').accessToken(['calendar.read'])).rejects.toMatchObject({ problem: 'revoked' })
    expect(t.connections.size).toBe(0)
  })

  it('lists and disconnects (revoking at Google)', async () => {
    const t = await connected(`openid email ${CAL_WRITE}`, () => ({ status: 500, json: {} }))
    const mgr = googleConnectionManager(t.deps, 'u1')
    expect(await mgr.list()).toEqual([{ provider: 'google', capabilities: ['calendar.read', 'calendar.write'] }])
    expect(await mgr.disconnect('google')).toBe(true)
    expect(t.fetchStub.calls.at(-1)!.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(t.fetchStub.calls.at(-1)!.body.get('token')).toBe('1//r')
    expect(await mgr.list()).toEqual([])
  })
})
