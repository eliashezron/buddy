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

// Must match CHANNELS in @wa/core (checked by test). drizzle-kit loads this file on its own, so no imports.
export const channel = pgEnum('channel', ['whatsapp', 'telegram'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  channel: channel('channel').notNull(),
  /** The user's id on the channel: wa_id (a phone number: never log in full) or Telegram chat id. */
  externalId: text('external_id').notNull(),
  displayName: text('display_name'),
  timezone: text('timezone').notNull(),
  /** Drives the 24 h customer service window check before every send. */
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_channel_external_id_key').on(t.channel, t.externalId)])

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    channel: channel('channel').notNull(),
    /** Channel message id (wamid, or `<botId>:<chatId>:<message_id>`). With `channel`, the idempotency key for at-least-once delivery. */
    externalMessageId: text('external_message_id').notNull(),
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
    uniqueIndex('messages_channel_external_id_key').on(t.channel, t.externalMessageId),
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
  'undone',
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
    /** The approval card the user saw ({ preview, title }), for outbound and money actions. */
    card: jsonb('card'),
    /** When the user approved or cancelled (audit trail for outbound and money actions). */
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    undoExpiresAt: timestamp('undo_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [index('actions_user_idx').on(t.userId, t.createdAt), index('actions_run_idx').on(t.runId)],
)

export const provider = pgEnum('provider', ['google'])

/**
 * A user's linked account at a provider. Tokens are encrypted (TokenCipher, AAD bound
 * to user + provider); nothing here is usable without the encryption key.
 */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: provider('provider').notNull(),
    /** The provider account's email, shown back to the user ("connected as …"). */
    accountEmail: text('account_email'),
    /** OAuth scopes the user actually granted (they can untick some). */
    scopes: text('scopes').array().notNull(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [uniqueIndex('connections_user_provider_key').on(t.userId, t.provider)],
)

/**
 * One-time OAuth link state. Only a SHA-256 hash of the token in the link is stored,
 * so a database leak can't be replayed. Expires after 15 minutes; used once.
 */
export const oauthStates = pgTable('oauth_states', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: provider('provider').notNull(),
  /** Capabilities offered on Google's consent screen (see CAPABILITIES in @wa/core). */
  capabilities: text('capabilities').array().notNull(),
  /** The subset the triggering request needs; the rest are optional for the user. Empty on older rows (= all needed). */
  needed: text('needed').array().notNull().default(sql`'{}'::text[]`),
  codeVerifierEnc: text('code_verifier_enc').notNull(),
  /** The message that needed the connection; re-run after the user connects. */
  triggerMessageId: uuid('trigger_message_id').references(() => messages.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
})

export type Channel = (typeof channel.enumValues)[number]
export type Connection = typeof connections.$inferSelect
export type OAuthState = typeof oauthStates.$inferSelect
export type User = typeof users.$inferSelect
export type Message = typeof messages.$inferSelect
export type Action = typeof actions.$inferSelect
export type ActionStatus = (typeof actionStatus.enumValues)[number]
