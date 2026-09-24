import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures')

/** Fixture as Meta would send it: `_fixture` stripped. */
export function fixture(name: string): Record<string, unknown> {
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'))
  return payload
}

export const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json') && !f.startsWith('telegram-'))
  .map((f) => f.replace(/\.json$/, ''))
