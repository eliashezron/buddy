import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, maskPhone, REDACTED, sanitize } from '../src/logger.js'

function capture() {
  const lines: Record<string, unknown>[] = []
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)))
      cb()
    },
  })
  return { logger: createLogger({ name: 'test', level: 'info', destination }), lines }
}

describe('logger redaction', () => {
  it('masks phone numbers to the last 4 digits', () => {
    expect(maskPhone('256770000001')).toBe('***0001')
    expect(maskPhone('+256 770 000 001')).toBe('***0001')
  })

  it('redacts bodies, transcripts and secrets at any depth', () => {
    const out = sanitize({
      message: { text: { body: 'book coffee with Amina' }, transcript: 'hello', from: '256770000001' },
      headers: { authorization: 'Bearer abc', 'x-hub-signature-256': 'sha256=ff' },
      accessToken: 'EAAG...',
      contacts: [{ wa_id: '256770000001' }],
    }) as Record<string, any>
    expect(out.message.text).toBe(REDACTED)
    expect(out.message.transcript).toBe(REDACTED)
    expect(out.message.from).toBe('***0001')
    expect(out.headers.authorization).toBe(REDACTED)
    expect(out.headers['x-hub-signature-256']).toBe(REDACTED)
    expect(out.accessToken).toBe(REDACTED)
    expect(out.contacts[0].wa_id).toBe('***0001')
  })

  it('masks phone numbers embedded in free text and messages but not timestamps', () => {
    const { logger, lines } = capture()
    logger.info({ note: 'call 256770000001 at 1790000000' }, 'user +256770000001 said hi')
    const line = lines[0]!
    expect(line.note).toBe('call ***0001 at 1790000000')
    expect(line.msg).toBe('user ***0001 said hi')
    expect(JSON.stringify(line)).not.toContain('256770000001')
  })

  it('keeps ids and metadata readable', () => {
    const { logger, lines } = capture()
    logger.info({ wamid: 'wamid.TEST_1', type: 'text', runId: 'r1' }, 'ok')
    expect(lines[0]).toMatchObject({ wamid: 'wamid.TEST_1', type: 'text', runId: 'r1', service: 'test' })
  })

  it('keeps error details, including DOMException timeouts and causes', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const err = new Error('send to 256770000001 failed', { cause: timeout })
    const out = sanitize({ err }) as { err: Record<string, any> }
    expect(out.err.type).toBe('Error')
    expect(out.err.message).toBe('send to ***0001 failed')
    expect(out.err.cause).toMatchObject({ type: 'TimeoutError', message: 'The operation was aborted due to timeout' })
  })

  it('keeps token usage counts but redacts token credentials', () => {
    const out = sanitize({ inputTokens: 120, output_tokens: 40, accessToken: 'EAAG', refresh_token: 'r', token: 't' })
    expect(out).toEqual({ inputTokens: 120, output_tokens: 40, accessToken: REDACTED, refresh_token: REDACTED, token: REDACTED })
  })

  it('redacts Telegram bot tokens inside URLs and error messages', () => {
    const msg = 'request to https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ/sendMessage failed'
    expect(sanitize(msg)).toBe('request to https://api.telegram.org/bot[REDACTED]/sendMessage failed')
  })

  it('logs the real error class name for subclassed errors passed as `err`', () => {
    class ApiError extends Error {
      override name = 'TelegramApiError'
      constructor(readonly permanent: boolean) {
        super('telegram 401: Unauthorized')
      }
    }
    const { logger, lines } = capture()
    logger.warn({ err: new ApiError(true) }, 'reply dropped')
    expect(lines[0]!.err).toMatchObject({ type: 'TelegramApiError', message: 'telegram 401: Unauthorized', permanent: true })
  })

  it('survives circular structures', () => {
    const a: Record<string, unknown> = { id: 1 }
    a.self = a
    expect(sanitize(a)).toEqual({ id: 1, self: '[Circular]' })
  })
})
