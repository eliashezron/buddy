import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// All timestamps are timestamptz and stored in UTC.
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** WhatsApp id (phone number in international format). Never log in full. */
  waId: text('wa_id').notNull().unique(),
  displayName: text('display_name'),
  timezone: text('timezone').notNull(),
  /** Drives the 24 h customer service window check before every send. */
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    /** Meta's `messages[].id`. Unique: this is the idempotency key for at-least-once delivery. */
    waMessageId: text('wa_message_id').notNull(),
    type: text('type').notNull(),
    /** Nulled by the retention job after MESSAGE_RETENTION_DAYS. */
    body: text('body'),
    /** Outbound delivery status: sent | delivered | read | failed. */
    status: text('status'),
    errorCodes: jsonb('error_codes').$type<number[]>(),
    /** When WhatsApp says the message was sent (inbound) or when we sent it (outbound). */
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_wa_message_id_key').on(t.waMessageId),
    index('messages_user_sent_at_idx').on(t.userId, t.sentAt),
  ],
)

export const runStatus = pgEnum('run_status', ['running', 'succeeded', 'failed', 'refused'])

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    triggerMessageId: uuid('trigger_message_id').references(() => messages.id, { onDelete: 'set null' }),
    status: runStatus('status').notNull().default('running'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_runs_user_idx').on(t.userId, t.createdAt)],
)

export const riskLevel = pgEnum('risk_level', ['read', 'low_write', 'outbound', 'money'])
export const actionStatus = pgEnum('action_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'awaiting_approval',
  'expired',
  'cancelled',
])

/** No tool runs without a row here: written before execution, updated after. */
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    risk: riskLevel('risk').notNull(),
    status: actionStatus('status').notNull().default('pending'),
    input: jsonb('input').notNull(),
    result: jsonb('result'),
    error: text('error'),
    approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }),
    undoExpiresAt: timestamp('undo_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [index('actions_user_idx').on(t.userId, t.createdAt), index('actions_run_idx').on(t.runId)],
)

export type User = typeof users.$inferSelect
export type Message = typeof messages.$inferSelect
export type Action = typeof actions.$inferSelect
export type ActionStatus = (typeof actionStatus.enumValues)[number]
