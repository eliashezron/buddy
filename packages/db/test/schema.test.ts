import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { CHANNELS } from '@wa/core'
import { schema } from '../src/index.js'

describe('schema', () => {
  it('makes wa_message_id unique: the idempotency key for at-least-once delivery', () => {
    const { indexes } = getTableConfig(schema.messages)
    const idx = indexes.find((i) => i.config.name === 'messages_channel_external_id_key')
    expect(idx?.config.unique).toBe(true)
  })

  it('stores every timestamp with time zone', () => {
    for (const table of [schema.users, schema.messages, schema.agentRuns, schema.actions]) {
      for (const col of getTableConfig(table).columns) {
        if (col.columnType === 'PgTimestamp') expect((col as unknown as { withTimezone: boolean }).withTimezone).toBe(true)
      }
    }
  })

  it('has a channel enum matching the core channel list', () => {
    expect(schema.channel.enumValues).toEqual([...CHANNELS])
  })

  it('makes (channel, external_id) unique for users', () => {
    const idx = getTableConfig(schema.users).indexes.find((i) => i.config.name === 'users_channel_external_id_key')
    expect(idx?.config.unique).toBe(true)
  })

  it('covers every tool risk level', () => {
    expect(schema.riskLevel.enumValues).toEqual(['read', 'low_write', 'outbound', 'money'])
  })
})
