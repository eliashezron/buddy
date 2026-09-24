import { z } from 'zod'

// Empty strings count as unset: `.env.example` ships with `KEY=` lines, and an
// empty secret must fail boot rather than pass as a valid value.
const required = () => z.string().trim().min(1)

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  WHATSAPP_PHONE_NUMBER_ID: required(),
  WHATSAPP_ACCESS_TOKEN: required(),
  WHATSAPP_APP_SECRET: required(),
  WHATSAPP_VERIFY_TOKEN: required(),
  WHATSAPP_WABA_ID: z.string().optional(),
  // Pinned on purpose (docs/whatsapp-notes.md §3); no default.
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'expected a version like v23.0'),

  ANTHROPIC_API_KEY: required(),
  AGENT_MODEL: z.string().default('claude-opus-5'),
  SEARCH_MODEL: z.string().default('claude-sonnet-5'),

  DEFAULT_TIMEZONE: z.string().default('Africa/Kampala'),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
})

export type Config = z.infer<typeof envSchema>

/** The subset `pnpm db:migrate` needs, so migrations don't require WhatsApp secrets. */
export const dbEnvSchema = envSchema.pick({ NODE_ENV: true, LOG_LEVEL: true, DATABASE_URL: true })

export class ConfigError extends Error {
  constructor(
    readonly missing: string[],
    readonly invalid: { key: string; reason: string }[],
  ) {
    const lines = ['Invalid environment configuration.']
    if (missing.length) lines.push(`  Missing: ${missing.join(', ')}`)
    for (const { key, reason } of invalid) lines.push(`  Invalid: ${key} (${reason})`)
    lines.push('  See .env.example for every variable and its purpose.')
    super(lines.join('\n'))
    this.name = 'ConfigError'
  }
}

type Env = Record<string, string | undefined>

/**
 * Parses env against a schema. Collects every problem before throwing, and only
 * ever reports variable *names*, never values, so secrets can't leak into logs.
 */
export function loadConfig<S extends z.ZodObject>(schema: S, env: Env = process.env): z.infer<S> {
  const input: Env = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]
    input[key] = value === undefined || value.trim() === '' ? undefined : value
  }

  const result = schema.safeParse(input)
  if (result.success) return result.data

  const missing = new Set<string>()
  const invalid: { key: string; reason: string }[] = []
  for (const issue of result.error.issues) {
    const key = String(issue.path[0])
    if (input[key] === undefined) missing.add(key)
    else invalid.push({ key, reason: issue.message })
  }
  throw new ConfigError([...missing].sort(), invalid)
}

/** Boot helper for app entrypoints: print a readable error and exit non-zero. */
export function loadConfigOrExit<S extends z.ZodObject>(schema: S, env: Env = process.env): z.infer<S> {
  try {
    return loadConfig(schema, env)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
}
