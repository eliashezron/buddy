import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Encrypts secrets at rest (OAuth tokens, PKCE verifiers). An interface, so the local
 * key can be swapped for a KMS-backed implementation (CLAUDE.md requires KMS in
 * production) without touching callers.
 *
 * `context` is authenticated but not encrypted (AES-GCM AAD): a ciphertext only
 * decrypts for the row it was written for, so tokens can't be swapped between users.
 */
export interface TokenCipher {
  encrypt(plaintext: string, context: string): string
  decrypt(ciphertext: string, context: string): string
}

const VERSION = 'v1'

/** AES-256-GCM with a 32-byte key from the environment (TOKEN_ENCRYPTION_KEY, base64). */
export function createLocalCipher(keyBase64: string): TokenCipher {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded')
  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(context))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
    },
    decrypt(ciphertext, context) {
      const [version, iv, tag, body] = ciphertext.split('.')
      if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('unrecognised ciphertext')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    },
  }
}
