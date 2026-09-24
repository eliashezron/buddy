import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino'

export type { Logger }

/**
 * Redaction works on key names at any depth, plus a phone-number scan over every
 * string. It cannot see PII that was interpolated into a message template, so the
 * rule is: log ids and metadata as fields, never `log.info(`got ${body}`)`.
 */

// Message content: bodies, captions, transcripts, prompts, search queries.
const CONTENT_KEYS = new Set([
  'body',
  'text',
  'caption',
  'transcript',
  'content',
  'prompt',
  'query',
  'messages',
])
const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|cookie|signature/i
const PHONE_KEYS = new Set([
  'from',
  'to',
  'wa_id',
  'waid',
  'recipient_id',
  'phone',
  'phone_number',
  'phonenumber',
  'display_phone_number',
  'msisdn',
])

// 11–15 digits, optionally with a leading +. E.164 numbers with a country code.
// Shorter runs (10-digit unix timestamps, ids) are left alone.
const PHONE_IN_TEXT = /\+?\b\d{11,15}\b/g

export const REDACTED = '[REDACTED]'

export function maskPhone(value: unknown): string {
  const digits = String(value).replace(/\D/g, '')
  return digits.length <= 4 ? '***' : `***${digits.slice(-4)}`
}

export function maskPhonesInText(text: string): string {
  return text.replace(PHONE_IN_TEXT, (m) => maskPhone(m))
}

export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return maskPhonesInText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8) return '[Truncated]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen))
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}b]`
  if (isErrorLike(value)) return sanitizeError(value, depth, seen)

  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    const k = key.toLowerCase()
    if (v === undefined || v === null) out[key] = v
    else if (SECRET_KEY.test(k) || CONTENT_KEYS.has(k)) out[key] = REDACTED
    else if (PHONE_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) out[key] = maskPhone(v)
    else out[key] = sanitize(v, depth + 1, seen)
  }
  return out
}

// Errors (and DOMExceptions such as AbortSignal.timeout's TimeoutError) keep
// name/message/stack on the prototype, so Object.entries alone would log `{}`.
function isErrorLike(value: object): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === '[object DOMException]'
}

function sanitizeError(err: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: err.name, message: maskPhonesInText(err.message) }
  const extra = err as Error & { code?: unknown; status?: unknown }
  if (extra.code !== undefined) out.code = extra.code
  if (extra.status !== undefined) out.status = extra.status
  if (err.stack) out.stack = maskPhonesInText(err.stack)
  if (err.cause !== undefined) out.cause = sanitize(err.cause, depth + 1, seen)
  const own = sanitize(Object.fromEntries(Object.entries(err)), depth + 1, seen) as Record<string, unknown>
  return { ...own, ...out }
}

export interface CreateLoggerOptions {
  name: string
  level?: string
  /** For tests: write to a custom destination. */
  destination?: DestinationStream
}

export function createLogger({ name, level, destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => sanitize(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const clean = args.map((a) => (typeof a === 'string' ? maskPhonesInText(a) : a)) as typeof args
        method.apply(this, clean)
      },
    },
  }

  if (destination) return pino(options, destination)

  const pretty = process.env.NODE_ENV === 'development' && process.stdout.isTTY
  if (pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } })
  }
  return pino(options)
}
