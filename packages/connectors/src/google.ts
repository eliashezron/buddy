import { createHash, randomBytes } from 'node:crypto'
import type { Capability } from '@wa/core'
import { z } from 'zod'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/** Always requested alongside capabilities, so we can show which account was connected. */
export const IDENTITY_SCOPES = ['openid', 'email']

const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.events.readonly'
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events'
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly'
// Google has no drafts-only scope: gmail.compose also allows sending. Sending stays gated
// by the `outbound` policy (approval required), not by the scope.
const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose'

/** Narrowest scope that grants each capability (PRD: request the narrowest scopes possible). */
export const CAPABILITY_SCOPE: Record<Capability, string> = {
  'calendar.read': CALENDAR_READ,
  'calendar.write': CALENDAR_WRITE,
  'gmail.read': GMAIL_READ,
  'gmail.compose': GMAIL_COMPOSE,
}

/** Scopes that also satisfy a capability (calendar write access includes reading events). */
const SATISFIED_BY: Record<Capability, string[]> = {
  'calendar.read': [CALENDAR_READ, CALENDAR_WRITE],
  'calendar.write': [CALENDAR_WRITE],
  'gmail.read': [GMAIL_READ],
  'gmail.compose': [GMAIL_COMPOSE],
}

export function grants(scopes: readonly string[], capability: Capability): boolean {
  return SATISFIED_BY[capability].some((s) => scopes.includes(s))
}

export function grantedCapabilities(scopes: readonly string[]): Capability[] {
  return (Object.keys(CAPABILITY_SCOPE) as Capability[]).filter((c) => grants(scopes, c))
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export class GoogleOAuthError extends Error {
  override name = 'GoogleOAuthError'
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`google oauth: ${code} (HTTP ${status})`)
  }
  /** The refresh token is dead (revoked, expired, password change): the user must reconnect. */
  get invalidGrant(): boolean {
    return this.code === 'invalid_grant'
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string(),
  id_token: z.string().optional(),
})
export type TokenResponse = z.infer<typeof tokenResponseSchema>

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  fetch?: typeof fetch
}

export function createGoogleOAuth(config: GoogleOAuthConfig) {
  const fetchImpl = config.fetch ?? fetch

  async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    })
    const json: unknown = await res.json().catch(() => ({}))
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(json)
      throw new GoogleOAuthError(code.success ? code.data.error : 'unknown_error', res.status)
    }
    return tokenResponseSchema.parse(json)
  }

  return {
    /** Incremental authorization: only the scopes asked for now, merged with what was granted before. */
    authUrl(opts: { scopes: string[]; state: string; codeChallenge: string; loginHint?: string }): string {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: [...IDENTITY_SCOPES, ...opts.scopes].join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        // Re-consent returns a refresh token even for returning users.
        prompt: 'consent',
        state: opts.state,
        code_challenge: opts.codeChallenge,
        code_challenge_method: 'S256',
      })
      if (opts.loginHint) params.set('login_hint', opts.loginHint)
      return `${GOOGLE_AUTH_URL}?${params}`
    },

    exchangeCode(code: string, codeVerifier: string) {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: config.redirectUri,
      })
    },

    refresh(refreshToken: string) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    },

    /** Best effort: a token that is already invalid is as good as revoked. */
    async revoke(token: string): Promise<void> {
      await fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined)
    },
  }
}

export type GoogleOAuth = ReturnType<typeof createGoogleOAuth>

/**
 * Email claim from the id_token. It came straight from Google's token endpoint over
 * TLS in the code exchange, so the signature needn't be verified here (OIDC Core 3.1.3.7).
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}
