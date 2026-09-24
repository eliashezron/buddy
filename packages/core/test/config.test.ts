import { describe, expect, it } from 'vitest'
import { ConfigError, dbEnvSchema, envSchema, loadConfig } from '../src/config.js'

const valid = {
  DATABASE_URL: 'postgres://wa:wa@localhost:5432/wa',
  REDIS_URL: 'redis://localhost:6379',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  WHATSAPP_ACCESS_TOKEN: 'token-value',
  WHATSAPP_APP_SECRET: 'secret-value',
  WHATSAPP_VERIFY_TOKEN: 'verify-value',
  GRAPH_API_VERSION: 'v23.0',
  ANTHROPIC_API_KEY: 'sk-test',
}
const REQUIRED = Object.keys(valid)

describe('loadConfig', () => {
  it('parses a complete env and applies defaults', () => {
    const config = loadConfig(envSchema, valid)
    expect(config.PORT).toBe(3000)
    expect(config.AGENT_MODEL).toBe('claude-opus-5')
    expect(config.DEFAULT_TIMEZONE).toBe('Africa/Kampala')
  })

  it.each(REQUIRED)('fails naming %s when it is missing', (key) => {
    const env = { ...valid, [key]: undefined }
    expect(() => loadConfig(envSchema, env)).toThrow(ConfigError)
    try {
      loadConfig(envSchema, env)
    } catch (err) {
      expect((err as ConfigError).missing).toEqual([key])
      expect((err as Error).message).toContain(key)
    }
  })

  it('treats empty strings as missing', () => {
    expect(() => loadConfig(envSchema, { ...valid, WHATSAPP_APP_SECRET: '  ' })).toThrow(/Missing: WHATSAPP_APP_SECRET/)
  })

  it('lists every missing variable at once', () => {
    try {
      loadConfig(envSchema, {})
      expect.unreachable()
    } catch (err) {
      expect((err as ConfigError).missing).toEqual([...REQUIRED].sort())
    }
  })

  it('reports invalid values by name without echoing the value', () => {
    try {
      loadConfig(envSchema, { ...valid, GRAPH_API_VERSION: 'latest', DATABASE_URL: 'mysql://secret-host/db' })
      expect.unreachable()
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('GRAPH_API_VERSION')
      expect(message).toContain('DATABASE_URL')
      expect(message).not.toContain('secret-host')
      expect(message).not.toContain('latest')
    }
  })

  it('keeps Telegram off by default and requires the webhook secret once a token is set', () => {
    expect(loadConfig(envSchema, valid).TELEGRAM_BOT_TOKEN).toBeUndefined()
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'
    expect(() => loadConfig(envSchema, { ...valid, TELEGRAM_BOT_TOKEN: token })).toThrow(/Missing: TELEGRAM_WEBHOOK_SECRET/)
    expect(loadConfig(envSchema, { ...valid, TELEGRAM_BOT_TOKEN: token, TELEGRAM_MODE: 'polling' }).TELEGRAM_MODE).toBe('polling')
    const secret = 'a'.repeat(40)
    expect(loadConfig(envSchema, { ...valid, TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret }).TELEGRAM_WEBHOOK_SECRET).toBe(secret)
    expect(() => loadConfig(envSchema, { ...valid, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toThrow(/Invalid: TELEGRAM_BOT_TOKEN/)
  })

  it('lets db:migrate run with only DATABASE_URL', () => {
    expect(loadConfig(dbEnvSchema, { DATABASE_URL: valid.DATABASE_URL }).DATABASE_URL).toBe(valid.DATABASE_URL)
  })
})
