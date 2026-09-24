import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { envSchema } from '../src/config.js'

const file = path.resolve(import.meta.dirname, '../../../.env.example')
const lines = readFileSync(file, 'utf8').split('\n')
const KEY_LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/
// Commented-out examples ("# KEY=value") count as documentation too.
const COMMENTED_KEY = /^#\s*([A-Z][A-Z0-9_]*)=/
const known = new Set(Object.keys(envSchema.shape))
// Set by the platform, not by people.
const PLATFORM = new Set(['RENDER_EXTERNAL_URL'])

describe('.env.example', () => {
  it('has only comments, blank lines and KEY=value lines (Docker Compose rejects anything else)', () => {
    const bad = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.trim() !== '' && !line.trimStart().startsWith('#') && !KEY_LINE.test(line))
    expect(bad).toEqual([])
  })

  it('never ships a value for a secret', () => {
    const secrets = /TOKEN|SECRET|API_KEY|PASSWORD/
    const filled = lines.map((l) => KEY_LINE.exec(l)).filter((m) => m && secrets.test(m[1]!) && m[2]!.trim() !== '')
    expect(filled.map((m) => m![1])).toEqual([])
  })

  it('documents every config variable, and only real ones', () => {
    const documented = new Set(
      lines.map((l) => KEY_LINE.exec(l)?.[1] ?? COMMENTED_KEY.exec(l)?.[1]).filter((k): k is string => Boolean(k)),
    )
    expect([...documented].filter((k) => !known.has(k))).toEqual([])
    expect([...known].filter((k) => !documented.has(k) && !PLATFORM.has(k) && k !== 'HOST')).toEqual([])
  })
})
