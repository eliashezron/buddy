import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm'
import type { Db } from './client.js'
import {
  actions,
  agentRuns,
  connections,
  messages,
  oauthStates,
  users,
  type ActionStatus,
  type Channel,
  type Connection,
  type OAuthState,
  type User,
} from './schema.js'

export type Risk = (typeof actions.$inferInsert)['risk']

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 }

export function createRepo(db: Db) {
  return {
    /** Creates the user on first contact and advances `last_inbound_at` (never backwards: webhooks are unordered). */
    async upsertUserOnInbound(input: {
      channel: Channel
      externalId: string
      displayName?: string
      at: Date
      timezone: string
    }): Promise<User> {
      const [row] = await db
        .insert(users)
        .values({
          channel: input.channel,
          externalId: input.externalId,
          displayName: input.displayName ?? null,
          timezone: input.timezone,
          lastInboundAt: input.at,
        })
        .onConflictDoNothing({ target: [users.channel, users.externalId] })
        .returning()
      if (row) return row

      const existing = await db.query.users.findFirst({
        where: and(eq(users.channel, input.channel), eq(users.externalId, input.externalId)),
      })
      if (!existing) throw new Error('user vanished during upsert')
      const patch: Partial<typeof users.$inferInsert> = {}
      if (!existing.lastInboundAt || existing.lastInboundAt < input.at) patch.lastInboundAt = input.at
      if (input.displayName && input.displayName !== existing.displayName) patch.displayName = input.displayName
      if (Object.keys(patch).length === 0) return existing
      const [updated] = await db.update(users).set(patch).where(eq(users.id, existing.id)).returning()
      return updated ?? existing
    },

    async getLastInboundAt(channel: Channel, externalId: string): Promise<Date | null> {
      const row = await db.query.users.findFirst({
        where: and(eq(users.channel, channel), eq(users.externalId, externalId)),
        columns: { lastInboundAt: true },
      })
      return row?.lastInboundAt ?? null
    },

    /**
     * Records an inbound message. `isNew` is false on redelivery; the caller then
     * checks `hasCompletedRun`, because a failed attempt that BullMQ retries has
     * already stored the row but not finished the work.
     */
    async insertInboundMessage(input: {
      userId: string
      channel: Channel
      externalMessageId: string
      type: string
      body: string | null
      sentAt: Date
    }): Promise<{ id: string; isNew: boolean }> {
      const [row] = await db
        .insert(messages)
        .values({ ...input, direction: 'inbound' })
        .onConflictDoNothing({ target: [messages.channel, messages.externalMessageId] })
        .returning({ id: messages.id })
      if (row) return { id: row.id, isNew: true }
      const existing = await db.query.messages.findFirst({
        where: and(eq(messages.channel, input.channel), eq(messages.externalMessageId, input.externalMessageId)),
        columns: { id: true },
      })
      if (!existing) throw new Error('message vanished during insert')
      return { id: existing.id, isNew: false }
    },

    async hasCompletedRun(messageId: string): Promise<boolean> {
      const row = await db.query.agentRuns.findFirst({
        where: and(eq(agentRuns.triggerMessageId, messageId), inArray(agentRuns.status, ['succeeded', 'refused'])),
        columns: { id: true },
      })
      return Boolean(row)
    },

    async insertOutboundMessage(input: {
      userId: string
      channel: Channel
      externalMessageId: string
      body: string
      sentAt: Date
    }) {
      await db
        .insert(messages)
        .values({ ...input, direction: 'outbound', type: 'text', status: 'sent' })
        .onConflictDoNothing({ target: [messages.channel, messages.externalMessageId] })
    },

    /** Applies a delivery status, ignoring out-of-order regressions (e.g. `delivered` arriving after `read`). */
    async applyStatus(input: {
      channel: Channel
      externalMessageId: string
      status: string
      errorCodes: number[]
    }): Promise<boolean> {
      const row = await db.query.messages.findFirst({
        where: and(eq(messages.channel, input.channel), eq(messages.externalMessageId, input.externalMessageId)),
        columns: { id: true, status: true },
      })
      if (!row) return false
      if ((STATUS_RANK[input.status] ?? 0) <= (STATUS_RANK[row.status ?? ''] ?? 0)) return false
      const patch: Partial<typeof messages.$inferInsert> = { status: input.status }
      if (input.errorCodes.length) patch.errorCodes = input.errorCodes
      await db.update(messages).set(patch).where(eq(messages.id, row.id))
      return true
    },

    /** Up to `limit` messages with bodies since `since`, oldest first, excluding the one being handled. */
    async recentConversation(userId: string, opts: { limit: number; since: Date; excludeId: string }) {
      const rows = await db
        .select({ direction: messages.direction, body: messages.body })
        .from(messages)
        .where(
          and(
            eq(messages.userId, userId),
            isNotNull(messages.body),
            gte(messages.sentAt, opts.since),
            ne(messages.id, opts.excludeId),
          ),
        )
        .orderBy(desc(messages.sentAt))
        .limit(opts.limit)
      return rows.reverse().map((r) => ({ direction: r.direction, body: r.body ?? '' }))
    },

    async createRun(input: { userId: string; triggerMessageId: string; model: string }): Promise<string> {
      const [row] = await db.insert(agentRuns).values(input).returning({ id: agentRuns.id })
      return row!.id
    },

    async finishRun(
      id: string,
      patch: { status: 'succeeded' | 'failed' | 'refused'; inputTokens: number; outputTokens: number; error?: string },
    ) {
      await db
        .update(agentRuns)
        .set({ ...patch, error: patch.error ?? null, finishedAt: new Date() })
        .where(eq(agentRuns.id, id))
    },

    async createAction(input: {
      userId: string
      runId: string
      tool: string
      risk: Risk
      status: ActionStatus
      input: unknown
      approvalExpiresAt?: Date
    }): Promise<string> {
      const [row] = await db.insert(actions).values(input).returning({ id: actions.id })
      return row!.id
    },

    async updateAction(
      id: string,
      patch: { status: ActionStatus; result?: unknown; error?: string; undoExpiresAt?: Date; approvalExpiresAt?: Date; card?: unknown },
    ) {
      await db.update(actions).set(patch).where(eq(actions.id, id))
    },

    /**
     * Applies a button press to an `awaiting_approval` action. The whole check is one UPDATE
     * (same user, still awaiting, not expired), so a double tap or a redelivered press can
     * claim it only once. `approved` hands back the row, now `running`, with its stored input.
     */
    async decideApproval(input: { actionId: string; userId: string; decision: 'approve' | 'cancel'; now: Date }) {
      const pending = and(
        eq(actions.id, input.actionId),
        eq(actions.userId, input.userId),
        eq(actions.status, 'awaiting_approval'),
        gt(actions.approvalExpiresAt, input.now),
      )
      const [claimed] = await db
        .update(actions)
        .set({ status: input.decision === 'approve' ? 'running' : 'cancelled', decidedAt: input.now })
        .where(pending)
        .returning()
      if (claimed) return { kind: input.decision === 'approve' ? ('approved' as const) : ('cancelled' as const), action: claimed }

      const row = await db.query.actions.findFirst({ where: and(eq(actions.id, input.actionId), eq(actions.userId, input.userId)) })
      if (!row) return { kind: 'not_found' as const }
      if (row.status === 'awaiting_approval') {
        await db.update(actions).set({ status: 'expired' }).where(and(eq(actions.id, row.id), eq(actions.status, 'awaiting_approval')))
        return { kind: 'expired' as const, action: row }
      }
      return { kind: 'already_decided' as const, action: row }
    },

    async getUserById(id: string): Promise<User | null> {
      return (await db.query.users.findFirst({ where: eq(users.id, id) })) ?? null
    },

    async getMessageById(id: string) {
      return (await db.query.messages.findFirst({ where: eq(messages.id, id) })) ?? null
    },

    /**
     * The most recent request's successful low_write actions whose undo window is still
     * open, newest first. One request can make several changes ("add these two events"),
     * and "undo" means all of them.
     */
    async latestUndoableActions(userId: string, now: Date) {
      const open = and(eq(actions.userId, userId), eq(actions.risk, 'low_write'), eq(actions.status, 'succeeded'), gt(actions.undoExpiresAt, now))
      const latest = await db.query.actions.findFirst({ where: open, orderBy: desc(actions.createdAt) })
      if (!latest) return []
      if (!latest.runId) return [latest]
      return db.query.actions.findMany({ where: and(open, eq(actions.runId, latest.runId)), orderBy: desc(actions.createdAt) })
    },

    // --- connectors ---

    async getConnection(userId: string, provider: Connection['provider']): Promise<Connection | null> {
      return (
        (await db.query.connections.findFirst({
          where: and(eq(connections.userId, userId), eq(connections.provider, provider)),
        })) ?? null
      )
    },

    async upsertConnection(input: {
      userId: string
      provider: Connection['provider']
      accountEmail: string | null
      scopes: string[]
      refreshTokenEnc: string
      accessTokenEnc: string
      accessTokenExpiresAt: Date
    }) {
      await db
        .insert(connections)
        .values(input)
        .onConflictDoUpdate({
          target: [connections.userId, connections.provider],
          set: {
            accountEmail: input.accountEmail,
            scopes: input.scopes,
            refreshTokenEnc: input.refreshTokenEnc,
            accessTokenEnc: input.accessTokenEnc,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
          },
        })
    },

    async updateAccessToken(id: string, accessTokenEnc: string, accessTokenExpiresAt: Date) {
      await db.update(connections).set({ accessTokenEnc, accessTokenExpiresAt }).where(eq(connections.id, id))
    },

    async deleteConnection(userId: string, provider: Connection['provider']): Promise<boolean> {
      const rows = await db
        .delete(connections)
        .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
        .returning({ id: connections.id })
      return rows.length > 0
    },

    async createOAuthState(input: Omit<OAuthState, 'createdAt' | 'usedAt'>) {
      await db.insert(oauthStates).values(input)
    },

    /** A state that is unused and unexpired, without consuming it (the start redirect). */
    async findLiveOAuthState(tokenHash: string, now: Date): Promise<OAuthState | null> {
      return (
        (await db.query.oauthStates.findFirst({
          where: and(eq(oauthStates.tokenHash, tokenHash), isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, now)),
        })) ?? null
      )
    },

    /** Atomically marks a live state used and returns it; null if unknown, expired or already used. */
    async consumeOAuthState(tokenHash: string, now: Date): Promise<OAuthState | null> {
      const [row] = await db
        .update(oauthStates)
        .set({ usedAt: now })
        .where(and(eq(oauthStates.tokenHash, tokenHash), isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, now)))
        .returning()
      return row ?? null
    },

    /** Retention (PRD: raw bodies kept 30 days). Keeps the row for audit, drops the content. */
    async purgeBodiesBefore(cutoff: Date): Promise<number> {
      const rows = await db
        .update(messages)
        .set({ body: null })
        .where(and(lt(messages.sentAt, cutoff), isNotNull(messages.body)))
        .returning({ id: messages.id })
      return rows.length
    },
  }
}

export type Repo = ReturnType<typeof createRepo>
