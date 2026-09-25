import type { Connection, OAuthState } from '@wa/db'
import type { ConnectorRepo } from './credentials.js'

/** In-memory ConnectorRepo for tests. Mirrors the SQL semantics that matter (single use, expiry). */
export function createMemoryConnectorRepo() {
  const connections = new Map<string, Connection>()
  const states = new Map<string, OAuthState>()
  let seq = 0
  const key = (userId: string, provider: string) => `${userId}:${provider}`
  const repo: ConnectorRepo = {
    async getConnection(userId, provider) {
      return connections.get(key(userId, provider)) ?? null
    },
    async upsertConnection(input) {
      const existing = connections.get(key(input.userId, input.provider))
      connections.set(key(input.userId, input.provider), {
        id: existing?.id ?? `conn_${++seq}`,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
        ...input,
      })
    },
    async updateAccessToken(id, accessTokenEnc, accessTokenExpiresAt) {
      for (const c of connections.values()) if (c.id === id) Object.assign(c, { accessTokenEnc, accessTokenExpiresAt })
    },
    async deleteConnection(userId, provider) {
      return connections.delete(key(userId, provider))
    },
    async createOAuthState(input) {
      states.set(input.tokenHash, { ...input, createdAt: new Date(), usedAt: null })
    },
    async findLiveOAuthState(tokenHash, now) {
      const s = states.get(tokenHash)
      return s && !s.usedAt && s.expiresAt > now ? s : null
    },
    async consumeOAuthState(tokenHash, now) {
      const s = states.get(tokenHash)
      if (!s || s.usedAt || s.expiresAt <= now) return null
      s.usedAt = now
      return s
    },
  }
  return { repo, connections, states }
}

/** A fetch that answers Google's token and revoke endpoints; records every request. */
export function fakeGoogleFetch(handlers: {
  token?: (body: URLSearchParams) => { status: number; json: unknown }
}) {
  const calls: { url: string; body: URLSearchParams }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body ?? ''))
    calls.push({ url, body })
    if (url.includes('/revoke')) return new Response('', { status: 200 })
    const r = handlers.token?.(body) ?? { status: 500, json: { error: 'no handler' } }
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** An unsigned id_token carrying an email claim (as Google's token endpoint returns). */
export function fakeIdToken(email: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64({ email, sub: '123' })}.sig`
}
