import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies `X-Hub-Signature-256` over the exact raw request bytes.
 * Must run before any JSON parsing: re-serialised JSON will not match.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false
  const hex = header.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  const received = Buffer.from(hex, 'hex')
  return expected.length === received.length && timingSafeEqual(expected, received)
}

/** Produces a valid header value. Used by `pnpm replay` and tests. */
export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
}
