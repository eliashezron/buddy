import { createHash, randomBytes } from 'node:crypto'
import {
  CAPABILITIES,
  NeedsConnectionError,
  type Capability,
  type ConnectionManager,
  type CredentialProvider,
  type Logger,
  type TokenCipher,
} from '@wa/core'
import type { Repo } from '@wa/db'
import { CAPABILITY_SCOPE, GOOGLE_CAPABILITIES, grantedCapabilities, grants, GoogleOAuthError, pkcePair, type GoogleOAuth } from './google.js'

export type ConnectorRepo = Pick<
  Repo,
  | 'getConnection'
  | 'upsertConnection'
  | 'updateAccessToken'
  | 'deleteConnection'
  | 'createOAuthState'
  | 'findLiveOAuthState'
  | 'consumeOAuthState'
>

export const CONNECT_LINK_TTL_MS = 15 * 60_000
/** Refresh a little before expiry so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 60_000

/** AAD contexts: a ciphertext only decrypts for the row it was written for. */
export const tokenContext = (userId: string, kind: 'refresh' | 'access') => `google:${userId}:${kind}`
export const verifierContext = (tokenHash: string) => `oauth-state:${tokenHash}`
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export interface GoogleConnectorDeps {
  repo: ConnectorRepo
  cipher: TokenCipher
  oauth: GoogleOAuth
  logger: Logger
  now?: () => Date
}

/** Access tokens for one user; refreshes as needed; turns a dead grant into NeedsConnectionError. */
export function googleCredentials(deps: GoogleConnectorDeps, userId: string): CredentialProvider {
  const now = deps.now ?? (() => new Date())
  return {
    async accessToken(capabilities: Capability[]) {
      const conn = await deps.repo.getConnection(userId, 'google')
      if (!conn) throw new NeedsConnectionError(capabilities, 'not_connected')
      const missing = capabilities.filter((c) => !grants(conn.scopes, c))
      if (missing.length) throw new NeedsConnectionError(missing, 'missing_permission')

      if (conn.accessTokenEnc && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - EXPIRY_MARGIN_MS > now().getTime()) {
        return deps.cipher.decrypt(conn.accessTokenEnc, tokenContext(userId, 'access'))
      }
      try {
        const fresh = await deps.oauth.refresh(deps.cipher.decrypt(conn.refreshTokenEnc, tokenContext(userId, 'refresh')))
        const expiresAt = new Date(now().getTime() + fresh.expires_in * 1000)
        await deps.repo.updateAccessToken(conn.id, deps.cipher.encrypt(fresh.access_token, tokenContext(userId, 'access')), expiresAt)
        return fresh.access_token
      } catch (err) {
        if (err instanceof GoogleOAuthError && err.invalidGrant) {
          // Revoked by the user at Google, expired, or password changed: forget it and ask again.
          await deps.repo.deleteConnection(userId, 'google')
          deps.logger.info({ userId }, 'google grant no longer valid; connection removed')
          throw new NeedsConnectionError(capabilities, 'revoked')
        }
        throw err
      }
    },
  }
}

export function googleConnectionManager(deps: GoogleConnectorDeps, userId: string): ConnectionManager {
  return {
    async list() {
      const conn = await deps.repo.getConnection(userId, 'google')
      if (!conn) return []
      return [{ provider: 'google', ...(conn.accountEmail ? { account: conn.accountEmail } : {}), capabilities: grantedCapabilities(conn.scopes) }]
    },
    async disconnect(provider) {
      const conn = await deps.repo.getConnection(userId, provider)
      if (!conn) return false
      await deps.oauth.revoke(deps.cipher.decrypt(conn.refreshTokenEnc, tokenContext(userId, 'refresh')))
      return deps.repo.deleteConnection(userId, provider)
    },
  }
}

/**
 * Creates a one-time connect link for exactly these capabilities. Only a hash of the
 * link token is stored, alongside the encrypted PKCE verifier.
 */
export async function createConnectLink(
  deps: GoogleConnectorDeps & { baseUrl: string },
  input: { userId: string; needed: Capability[]; triggerMessageId: string | null },
): Promise<{ url: string; expiresAt: Date }> {
  const now = deps.now ?? (() => new Date())
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const { verifier } = pkcePair()
  const expiresAt = new Date(now().getTime() + CONNECT_LINK_TTL_MS)
  await deps.repo.createOAuthState({
    tokenHash,
    userId: input.userId,
    provider: 'google',
    // Everything at once: Google shows a checkbox per permission, so the user picks what to
    // allow and isn't asked again later. `needed` is what this request can't do without.
    capabilities: [...new Set([...input.needed, ...GOOGLE_CAPABILITIES])],
    needed: [...new Set(input.needed)],
    codeVerifierEnc: deps.cipher.encrypt(verifier, verifierContext(tokenHash)),
    triggerMessageId: input.triggerMessageId,
    expiresAt,
  })
  return { url: `${deps.baseUrl}/oauth/google/start?s=${token}`, expiresAt }
}

/** "see your calendar events and read your email" */
export function describeCapabilities(capabilities: Capability[]): string {
  const labels = [...new Set(capabilities)].map((c) => CAPABILITIES[c].label)
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

export function productsFor(capabilities: Capability[]): string[] {
  return [...new Set(capabilities.map((c) => CAPABILITIES[c].product))]
}

export { CAPABILITY_SCOPE }
