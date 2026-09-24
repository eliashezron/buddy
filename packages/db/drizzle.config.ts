import { defineConfig } from 'drizzle-kit'

// Only used to *generate* migrations; no connection needed. Apply with `pnpm db:migrate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
