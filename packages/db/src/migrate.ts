import { fileURLToPath } from 'node:url'
import { createLogger, dbEnvSchema, loadConfigOrExit } from '@wa/core'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'

const config = loadConfigOrExit(dbEnvSchema)
const logger = createLogger({ name: 'db-migrate', level: config.LOG_LEVEL })
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
try {
  await migrate(db, { migrationsFolder })
  logger.info({ migrationsFolder }, 'migrations applied')
} catch (err) {
  logger.error({ err }, 'migration failed')
  process.exitCode = 1
} finally {
  await close()
}
