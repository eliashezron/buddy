import { fileURLToPath } from 'node:url'
import { createLogger, dbEnvSchema, loadConfigOrExit } from '@wa/core'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'

const config = loadConfigOrExit(dbEnvSchema)
const logger = createLogger({ name: 'db-migrate', level: config.LOG_LEVEL })
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

// One connection, so the session-level advisory lock and the migration share it.
const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
try {
  // Several services run this before deploying (Render preDeployCommand). The lock
  // serialises them: the first applies pending migrations, the rest find none.
  await db.execute(sql`select pg_advisory_lock(hashtext('buddy:migrations'))`)
  try {
    await migrate(db, { migrationsFolder })
    logger.info({ migrationsFolder }, 'migrations applied')
  } finally {
    await db.execute(sql`select pg_advisory_unlock(hashtext('buddy:migrations'))`)
  }
} catch (err) {
  logger.error({ err }, 'migration failed')
  process.exitCode = 1
} finally {
  await close()
}
