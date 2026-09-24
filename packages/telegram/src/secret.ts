import { timingSafeEqual } from 'node:crypto'

/**
 * Telegram signs nothing; instead it echoes the `secret_token` given to setWebhook in
 * `X-Telegram-Bot-Api-Secret-Token`. Compare in constant time before touching the body.
 */
export function verifySecretToken(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string' || !expected) return false
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
