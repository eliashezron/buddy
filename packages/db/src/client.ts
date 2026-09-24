import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export function createDb(databaseUrl: string, opts: { max?: number } = {}) {
  const sql = postgres(databaseUrl, { max: opts.max ?? 10, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { db, close: () => sql.end({ timeout: 5 }) }
}

export type Db = ReturnType<typeof createDb>['db']
