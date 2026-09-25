import { createHash } from 'node:crypto'
import type { Capability } from '@wa/core'
import { CAPABILITY_SCOPE, emailFromIdToken, grantedCapabilities, GoogleOAuthError } from './google.js'
import { hashToken, tokenContext, verifierContext, type GoogleConnectorDeps } from './credentials.js'

export type ConnectOutcome =
  | {
      kind: 'connected'
      userId: string
      triggerMessageId: string | null
      /** Offered on the consent screen. */
      requested: Capability[]
      /** What the triggering request needs. */
      needed: Capability[]
      /** Everything the user has allowed, including earlier grants. */
      granted: Capability[]
      /** Needed capabilities the user unticked. Optional ones they unticked are not "missing". */
      missing: Capability[]
      account: string | null
    }
  | { kind: 'denied'; userId: string; triggerMessageId: string | null; requested: Capability[]; needed: Capability[] }
  | { kind: 'failed'; userId: string; triggerMessageId: string | null; requested: Capability[]; needed: Capability[]; reason: string }
  /** Unknown, expired or already-used link. Nothing to tell the chat about. */
  | { kind: 'invalid' }

const now = (deps: GoogleConnectorDeps) => (deps.now ?? (() => new Date()))()

/** GET /oauth/google/start: the Google consent URL for a live link, or null if the link is dead. */
export async function startAuthorization(deps: GoogleConnectorDeps, token: string): Promise<string | null> {
  const tokenHash = hashToken(token)
  const state = await deps.repo.findLiveOAuthState(tokenHash, now(deps))
  if (!state) return null
  const verifier = deps.cipher.decrypt(state.codeVerifierEnc, verifierContext(tokenHash))
  const existing = await deps.repo.getConnection(state.userId, 'google')
  return deps.oauth.authUrl({
    scopes: (state.capabilities as Capability[]).map((c) => CAPABILITY_SCOPE[c]),
    state: token,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(existing?.accountEmail ? { loginHint: existing.accountEmail } : {}),
  })
}

/** GET /oauth/google/callback. The state is consumed first, so a link works exactly once. */
export async function completeAuthorization(
  deps: GoogleConnectorDeps,
  params: { state?: string; code?: string; error?: string },
): Promise<ConnectOutcome> {
  if (!params.state) return { kind: 'invalid' }
  const tokenHash = hashToken(params.state)
  const state = await deps.repo.consumeOAuthState(tokenHash, now(deps))
  if (!state) return { kind: 'invalid' }
  const requested = state.capabilities as Capability[]
  // Links from before `needed` existed asked for exactly what they needed.
  const needed = state.needed.length ? (state.needed as Capability[]) : requested
  const base = { userId: state.userId, triggerMessageId: state.triggerMessageId, requested, needed }
  if (params.error || !params.code) return { kind: 'denied', ...base }

  try {
    const verifier = deps.cipher.decrypt(state.codeVerifierEnc, verifierContext(tokenHash))
    const tokens = await deps.oauth.exchangeCode(params.code, verifier)
    // include_granted_scopes: `scope` already contains earlier grants plus these.
    const scopes = tokens.scope.split(' ').filter(Boolean)
    const existing = await deps.repo.getConnection(state.userId, 'google')
    const refreshToken =
      tokens.refresh_token ?? (existing ? deps.cipher.decrypt(existing.refreshTokenEnc, tokenContext(state.userId, 'refresh')) : null)
    if (!refreshToken) return { kind: 'failed', ...base, reason: 'Google did not return a refresh token' }

    const account = emailFromIdToken(tokens.id_token) ?? existing?.accountEmail ?? null
    await deps.repo.upsertConnection({
      userId: state.userId,
      provider: 'google',
      accountEmail: account,
      scopes,
      refreshTokenEnc: deps.cipher.encrypt(refreshToken, tokenContext(state.userId, 'refresh')),
      accessTokenEnc: deps.cipher.encrypt(tokens.access_token, tokenContext(state.userId, 'access')),
      accessTokenExpiresAt: new Date(now(deps).getTime() + tokens.expires_in * 1000),
    })
    const granted = grantedCapabilities(scopes)
    return { kind: 'connected', ...base, granted, missing: needed.filter((c) => !granted.includes(c)), account }
  } catch (err) {
    const reason = err instanceof GoogleOAuthError ? err.code : 'token exchange failed'
    deps.logger.error({ err, userId: state.userId }, 'google authorization failed')
    return { kind: 'failed', ...base, reason }
  }
}
