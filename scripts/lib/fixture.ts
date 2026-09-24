import { readFileSync } from 'node:fs'
import path from 'node:path'

export const FIXTURES_DIR = path.resolve(import.meta.dirname, '../../fixtures')

/** Accepts `book-meeting`, `book-meeting.json` or `fixtures/book-meeting.json`. Refuses paths outside fixtures/. */
export function resolveFixture(arg: string, cwd = process.cwd()): string {
  const candidates = [path.resolve(cwd, arg), path.resolve(FIXTURES_DIR, arg), path.resolve(FIXTURES_DIR, `${arg}.json`)]
  for (const file of candidates) {
    const rel = path.relative(FIXTURES_DIR, file)
    if (rel.startsWith('..') || path.isAbsolute(rel) || !file.endsWith('.json')) continue
    try {
      readFileSync(file)
      return file
    } catch {
      /* try next */
    }
  }
  throw new Error(`fixture not found in fixtures/: ${arg}`)
}

export interface NormaliseOptions {
  env?: Record<string, string | undefined>
  /** Shift message/status timestamps so the newest is `now` (keeps the 24 h window open). */
  rebaseTo?: Date
  /** Appended to message ids so a replay isn't deduplicated as a redelivery. */
  idSuffix?: string
}

const PLACEHOLDERS: Record<string, string> = {
  PHONE_NUMBER_ID_PLACEHOLDER: 'WHATSAPP_PHONE_NUMBER_ID',
  WABA_ID_PLACEHOLDER: 'WHATSAPP_WABA_ID',
  MEDIA_ID_PLACEHOLDER: 'REPLAY_MEDIA_ID',
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function mapStrings(value: Json, fn: (s: string, key: string | undefined) => string, key?: string): Json {
  if (typeof value === 'string') return fn(value, key)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]))
  }
  return value
}

function collectTimestamps(value: Json, out: number[] = []): number[] {
  if (Array.isArray(value)) value.forEach((v) => collectTimestamps(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'timestamp' && typeof v === 'string' && /^\d+$/.test(v)) out.push(Number(v))
      else collectTimestamps(v, out)
    }
  }
  return out
}

/**
 * Turns a fixture file into what Meta would actually send: `_fixture` removed
 * (production code must never see it) and placeholders filled from env.
 */
export function isTelegramUpdate(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'update_id' in payload
}

export function normaliseFixture(raw: unknown, opts: NormaliseOptions = {}): Json {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('fixture must be a JSON object')
  const { _fixture: _meta, ...payload } = raw as Record<string, Json>
  if (isTelegramUpdate(payload)) return normaliseTelegram(payload, opts)
  const env = opts.env ?? {}
  const newest = Math.max(0, ...collectTimestamps(payload))
  const offset = opts.rebaseTo && newest ? Math.floor(opts.rebaseTo.getTime() / 1000) - newest : 0

  return mapStrings(payload, (s, key) => {
    let out = s
    for (const [placeholder, envKey] of Object.entries(PLACEHOLDERS)) {
      const value = env[envKey]
      if (value && out.includes(placeholder)) out = out.replaceAll(placeholder, value)
    }
    if (key === 'timestamp' && offset && /^\d+$/.test(out)) out = String(Number(out) + offset)
    if (opts.idSuffix && key === 'id' && out.startsWith('wamid.')) out = `${out}_${opts.idSuffix}`
    return out
  })
}

export function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Telegram updates: numeric ids and a `date` field. Live replays move the date to now
 * and shift message_id/update_id so the same fixture can be replayed repeatedly.
 */
function normaliseTelegram(payload: Record<string, Json>, opts: NormaliseOptions): Json {
  const out = structuredClone(payload) as Record<string, any>
  const shift = opts.idSuffix ? parseInt(opts.idSuffix, 16) : 0
  if (shift) out.update_id = Number(out.update_id) + shift
  const message = out.message
  if (message && typeof message === 'object') {
    if (opts.rebaseTo) message.date = Math.floor(opts.rebaseTo.getTime() / 1000)
    if (shift) message.message_id = Number(message.message_id) + shift
  }
  return out as Json
}
