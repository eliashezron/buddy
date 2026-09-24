import { and, desc, eq, gte, inArray, isNotNull, lt, ne } from 'drizzle-orm'
import type { Db } from './client.js'
import { actions, agentRuns, messages, users, type ActionStatus, type User } from './schema.js'

export type Risk = (typeof actions.$inferInsert)['risk']

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 }

export function createRepo(db: Db) {
  return {
    /** Creates the user on first contact and advances `last_inbound_at` (never backwards: webhooks are unordered). */
    async upsertUserOnInbound(input: { waId: string; displayName?: string; at: Date; timezone: string }): Promise<User> {
      const [row] = await db
        .insert(users)
        .values({
          waId: input.waId,
          displayName: input.displayName ?? null,
          timezone: input.timezone,
          lastInboundAt: input.at,
        })
        .onConflictDoNothing({ target: users.waId })
        .returning()
      if (row) return row

      const existing = await db.query.users.findFirst({ where: eq(users.waId, input.waId) })
      if (!existing) throw new Error('user vanished during upsert')
      const patch: Partial<typeof users.$inferInsert> = {}
      if (!existing.lastInboundAt || existing.lastInboundAt < input.at) patch.lastInboundAt = input.at
      if (input.displayName && input.displayName !== existing.displayName) patch.displayName = input.displayName
      if (Object.keys(patch).length === 0) return existing
      const [updated] = await db.update(users).set(patch).where(eq(users.id, existing.id)).returning()
      return updated ?? existing
    },

    async getLastInboundAt(waId: string): Promise<Date | null> {
      const row = await db.query.users.findFirst({ where: eq(users.waId, waId), columns: { lastInboundAt: true } })
      return row?.lastInboundAt ?? null
    },

    /**
     * Records an inbound message. `isNew` is false on redelivery; the caller then
     * checks `hasCompletedRun`, because a failed attempt that BullMQ retries has
     * already stored the row but not finished the work.
     */
    async insertInboundMessage(input: {
      userId: string
      waMessageId: string
      type: string
      body: string | null
      sentAt: Date
    }): Promise<{ id: string; isNew: boolean }> {
      const [row] = await db
        .insert(messages)
        .values({ ...input, direction: 'inbound' })
        .onConflictDoNothing({ target: messages.waMessageId })
        .returning({ id: messages.id })
      if (row) return { id: row.id, isNew: true }
      const existing = await db.query.messages.findFirst({
        where: eq(messages.waMessageId, input.waMessageId),
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

    async insertOutboundMessage(input: { userId: string; waMessageId: string; body: string; sentAt: Date }) {
      await db
        .insert(messages)
        .values({ ...input, direction: 'outbound', type: 'text', status: 'sent' })
        .onConflictDoNothing({ target: messages.waMessageId })
    },

    /** Applies a delivery status, ignoring out-of-order regressions (e.g. `delivered` arriving after `read`). */
    async applyStatus(input: { waMessageId: string; status: string; errorCodes: number[] }): Promise<boolean> {
      const row = await db.query.messages.findFirst({
        where: eq(messages.waMessageId, input.waMessageId),
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
      patch: { status: ActionStatus; result?: unknown; error?: string; undoExpiresAt?: Date },
    ) {
      await db.update(actions).set(patch).where(eq(actions.id, id))
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
