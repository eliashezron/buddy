import { z } from 'zod'

// Empty strings count as unset: `.env.example` ships with `KEY=` lines, and an
// empty secret must fail boot rather than pass as a valid value.
const required = () => z.string().trim().min(1)

const baseEnvSchema = z.object({
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

  // Required unless LLM_PROVIDER=opencode (checked below).
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  AGENT_MODEL: z.string().default('claude-opus-5'),
  // Development only: run the agent on an OpenAI-style model via an OpenAI Responses
  // endpoint (OpenCode Zen). Refused in production (CLAUDE.md: zero-retention vendors only).
  LLM_PROVIDER: z.enum(['anthropic', 'opencode']).default('anthropic'),
  OPENCODE_API_KEY: z.string().trim().min(1).optional(),
  OPENCODE_BASE_URL: z.url().default('https://opencode.ai/zen'),
  SEARCH_MODEL: z.string().default('claude-sonnet-5'),

  // Telegram is optional: setting the bot token turns the channel on.
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, 'expected a BotFather token like 123456:ABC…').optional(),
  // Sent back by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call.
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[\w-]{32,256}$/, 'use 32–256 chars of A-Z, a-z, 0-9, _ or -').optional(),
  // webhook: Telegram POSTs to /telegram/webhook. polling: the api long-polls (local dev, no tunnel).
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  // Polling refuses to start while a webhook is registered (it would take the bot away
  // from production). Set to true to take over anyway.
  TELEGRAM_POLLING_TAKEOVER: z.stringbool().default(false),

  // Public https base URL of the api. In webhook mode the api registers
  // <url>/telegram/webhook with Telegram on boot. Render sets RENDER_EXTERNAL_URL itself.
  PUBLIC_BASE_URL: z
    .url()
    .refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u), 'must be https (or http://localhost for local development)')
    .optional(),
  RENDER_EXTERNAL_URL: z.url().optional(),

  // Google connectors (Calendar, Gmail). Optional: without a client id the tools are off.
  GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
  // 32 random bytes, base64 (openssl rand -base64 32). Encrypts OAuth tokens at rest.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((k) => Buffer.from(k, 'base64').length === 32, 'must be 32 bytes, base64 (openssl rand -base64 32)')
    .optional(),

  DEFAULT_TIMEZONE: z.string().default('Africa/Kampala'),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
})

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.LLM_PROVIDER === 'opencode') {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_PROVIDER'],
        message: 'opencode is for development only: CLAUDE.md requires zero-retention model vendors for user messages',
      })
    }
    if (!env.OPENCODE_API_KEY) ctx.addIssue({ code: 'custom', path: ['OPENCODE_API_KEY'], message: 'required when LLM_PROVIDER=opencode' })
  } else if (!env.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'Missing: ANTHROPIC_API_KEY (required unless LLM_PROVIDER=opencode)' })
  }
  if (env.GOOGLE_CLIENT_ID) {
    for (const key of ['GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when GOOGLE_CLIENT_ID is set' })
    }
    if (!env.PUBLIC_BASE_URL && !env.RENDER_EXTERNAL_URL) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'required when GOOGLE_CLIENT_ID is set (OAuth redirect and connect links)' })
    }
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['TELEGRAM_WEBHOOK_SECRET'],
      message: 'required when TELEGRAM_BOT_TOKEN is set in webhook mode',
    })
  }
})

export type Config = z.infer<typeof envSchema>

/** The subset `pnpm db:migrate` needs, so migrations don't require WhatsApp secrets. */
export const dbEnvSchema = baseEnvSchema.pick({ NODE_ENV: true, LOG_LEVEL: true, DATABASE_URL: true })

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

/** Public base URL of the api: explicit PUBLIC_BASE_URL, else Render's own. No trailing slash. */
export function publicBaseUrl(config: Pick<Config, 'PUBLIC_BASE_URL' | 'RENDER_EXTERNAL_URL'>): string | undefined {
  return (config.PUBLIC_BASE_URL ?? config.RENDER_EXTERNAL_URL)?.replace(/\/$/, '')
}
