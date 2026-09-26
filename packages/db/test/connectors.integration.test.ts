import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createRepo, type Repo } from '../src/index.js'

const url = process.env.TEST_DATABASE_URL
const suffix = Math.random().toString(36).slice(2, 8)

describe.skipIf(!url)('connector repo (postgres)', () => {
  let repo: Repo
  let close: () => Promise<void>
  let userId: string
  beforeAll(async () => {
    const db = createDb(url!, { max: 4 })
    repo = createRepo(db.db)
    close = db.close
    userId = (await repo.upsertUserOnInbound({ channel: 'telegram', externalId: `c${suffix}`, at: new Date(), timezone: 'Africa/Kampala' })).id
  })
  afterAll(() => close())

  const state = (hash: string, expiresAt: Date) => ({
    tokenHash: hash,
    userId,
    provider: 'google' as const,
    capabilities: ['calendar.read'],
    codeVerifierEnc: 'enc',
    triggerMessageId: null,
    expiresAt,
  })

  it('consumes an OAuth state exactly once, even under a race', async () => {
    const now = new Date()
    await repo.createOAuthState(state(`h1-${suffix}`, new Date(now.getTime() + 60_000)))
    expect(await repo.findLiveOAuthState(`h1-${suffix}`, now)).not.toBeNull()
    const results = await Promise.all([1, 2, 3, 4].map(() => repo.consumeOAuthState(`h1-${suffix}`, new Date())))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await repo.findLiveOAuthState(`h1-${suffix}`, new Date())).toBeNull()
  })

  it('never returns an expired state', async () => {
    const now = new Date()
    await repo.createOAuthState(state(`h2-${suffix}`, new Date(now.getTime() - 1)))
    expect(await repo.findLiveOAuthState(`h2-${suffix}`, now)).toBeNull()
    expect(await repo.consumeOAuthState(`h2-${suffix}`, now)).toBeNull()
  })

  it('upserts one connection per user and provider, and deletes it', async () => {
    const base = { userId, provider: 'google' as const, accountEmail: 'a@example.com', refreshTokenEnc: 'r1', accessTokenEnc: 'a1', accessTokenExpiresAt: new Date() }
    await repo.upsertConnection({ ...base, scopes: ['s1'] })
    await repo.upsertConnection({ ...base, scopes: ['s1', 's2'], refreshTokenEnc: 'r2' })
    const conn = await repo.getConnection(userId, 'google')
    expect(conn).toMatchObject({ scopes: ['s1', 's2'], refreshTokenEnc: 'r2' })
    await repo.updateAccessToken(conn!.id, 'a2', new Date(0))
    expect((await repo.getConnection(userId, 'google'))!.accessTokenEnc).toBe('a2')
    expect(await repo.deleteConnection(userId, 'google')).toBe(true)
    expect(await repo.getConnection(userId, 'google')).toBeNull()
  })

  it('finds the latest request\'s undoable actions, only inside their window', async () => {
    const run = async (n: number) => {
      const msg = await repo.insertInboundMessage({ userId, channel: 'telegram', externalMessageId: `c${suffix}:${n}`, type: 'text', body: 'x', sentAt: new Date() })
      return repo.createRun({ userId, triggerMessageId: msg.id, model: 'm' })
    }
    const now = new Date()
    const add = async (runId: string, undoExpiresAt: Date) => {
      const id = await repo.createAction({ userId, runId, tool: 'create_calendar_event', risk: 'low_write', status: 'running', input: {} })
      await repo.updateAction(id, { status: 'succeeded', result: { ok: true }, undoExpiresAt })
      return id
    }
    const inWindow = new Date(now.getTime() + 60_000)
    const older = await add(await run(1), inWindow)
    const latestRun = await run(2)
    const a = await add(latestRun, inWindow)
    const b = await add(latestRun, inWindow)
    expect((await repo.latestUndoableActions(userId, now)).map((x) => x.id)).toEqual([b, a])
    await repo.updateAction(a, { status: 'undone' })
    await repo.updateAction(b, { status: 'undone' })
    // The earlier request becomes the latest undoable one.
    expect((await repo.latestUndoableActions(userId, now)).map((x) => x.id)).toEqual([older])
    await repo.updateAction(older, { status: 'undone' })
    await add(await run(3), new Date(now.getTime() - 1))
    expect(await repo.latestUndoableActions(userId, now)).toEqual([])
  })

  it('approves an outbound action at most once, only for its user, only before it expires', async () => {
    const msg = await repo.insertInboundMessage({ userId, channel: 'telegram', externalMessageId: `c${suffix}:appr`, type: 'text', body: 'x', sentAt: new Date() })
    const runId = await repo.createRun({ userId, triggerMessageId: msg.id, model: 'm' })
    const now = new Date()
    const pending = async (expiresAt: Date) => {
      const id = await repo.createAction({ userId, runId, tool: 'gmail_send_email', risk: 'outbound', status: 'pending', input: { to: ['k@example.com'] } })
      await repo.updateAction(id, { status: 'awaiting_approval', approvalExpiresAt: expiresAt })
      return id
    }
    const later = new Date(now.getTime() + 15 * 60_000)

    // Four taps at once: exactly one claims it.
    const a = await pending(later)
    const taps = await Promise.all([1, 2, 3, 4].map(() => repo.decideApproval({ actionId: a, userId, decision: 'approve', now })))
    expect(taps.filter((t) => t.kind === 'approved')).toHaveLength(1)
    expect(taps.filter((t) => t.kind === 'already_decided')).toHaveLength(3)
    const approved = taps.find((t) => t.kind === 'approved')!
    expect(approved).toMatchObject({ action: { id: a, status: 'running', input: { to: ['k@example.com'] } } })
    expect((approved as { action: { decidedAt: Date } }).action.decidedAt).toBeInstanceOf(Date)

    // Another user can't touch it, and learns nothing about it.
    const b = await pending(later)
    const otherUser = (await repo.upsertUserOnInbound({ channel: 'telegram', externalId: `other${suffix}`, at: now, timezone: 'UTC' })).id
    expect(await repo.decideApproval({ actionId: b, userId: otherUser, decision: 'approve', now })).toEqual({ kind: 'not_found' })

    // Cancel, then approve: stays cancelled.
    expect((await repo.decideApproval({ actionId: b, userId, decision: 'cancel', now })).kind).toBe('cancelled')
    expect((await repo.decideApproval({ actionId: b, userId, decision: 'approve', now })).kind).toBe('already_decided')

    // Expired: not approvable, and marked expired.
    const c = await pending(new Date(now.getTime() - 1))
    expect((await repo.decideApproval({ actionId: c, userId, decision: 'approve', now })).kind).toBe('expired')
    expect((await repo.decideApproval({ actionId: c, userId, decision: 'approve', now })).kind).toBe('already_decided')
  })

  it('daily brief: candidates are opted-in users and Telegram users who did not opt out; a day is claimed once', async () => {
    const at = new Date()
    const mk = async (channel: 'telegram' | 'whatsapp', id: string) => (await repo.upsertUserOnInbound({ channel, externalId: `${id}${suffix}`, at, timezone: 'UTC' })).id
    const tgDefault = await mk('telegram', 'bt1')
    const tgOff = await mk('telegram', 'bt2')
    const waDefault = await mk('whatsapp', 'bw1')
    const waOn = await mk('whatsapp', 'bw2')
    await repo.setDailyBrief(tgOff, { enabled: false })
    await repo.setDailyBrief(waOn, { enabled: true, time: '06:30', timezone: 'Africa/Nairobi' })
    const ids = new Set((await repo.briefCandidates()).map((u) => u.id))
    expect([tgDefault, tgOff, waDefault, waOn].map((id) => ids.has(id))).toEqual([true, false, false, true])
    const waUser = (await repo.briefCandidates()).find((u) => u.id === waOn)!
    expect(waUser).toMatchObject({ briefTime: '06:30', timezone: 'Africa/Nairobi' })

    // Four ticks race for the same day: one wins.
    const claims = await Promise.all([1, 2, 3, 4].map(() => repo.claimBrief(tgDefault, '2026-09-27')))
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await repo.claimBrief(tgDefault, '2026-09-28')).toBe(true)
  })

  it('attachments: bytes round-trip, history includes captionless photos until they expire, newer inbound', async () => {
    const u = (await repo.upsertUserOnInbound({ channel: 'telegram', externalId: `att${suffix}`, at: new Date(), timezone: 'UTC' })).id
    const now = new Date()
    const msg = (n: number, type: string, body: string | null) =>
      repo.insertInboundMessage({ userId: u, channel: 'telegram', externalMessageId: `att${suffix}:${n}`, type, body, sentAt: new Date(now.getTime() + n) })
    const photo = await msg(1, 'image', null)
    const doc = await msg(2, 'document', 'summarise')
    const bytes = new Uint8Array([0xff, 0xd8, 0, 1, 255])
    await repo.saveAttachment({ messageId: photo.id, userId: u, attachment: { kind: 'image', mimeType: 'image/jpeg', data: bytes }, sizeBytes: 5, expiresAt: new Date(now.getTime() + 60_000) })
    // A redelivery keeps the first copy.
    await repo.saveAttachment({ messageId: photo.id, userId: u, attachment: { kind: 'image', mimeType: 'image/png', data: new Uint8Array([1]) }, sizeBytes: 1, expiresAt: new Date(now.getTime() + 60_000) })
    await repo.saveAttachment({ messageId: doc.id, userId: u, attachment: { kind: 'text', mimeType: 'text/csv', filename: 'a.csv', text: 'a,b', truncated: true }, sizeBytes: 3, expiresAt: new Date(now.getTime() - 1) })

    expect(await repo.hasNewerInbound(u, photo.id)).toBe(true)
    expect(await repo.hasNewerInbound(u, doc.id)).toBe(false)
    const text = await msg(3, 'text', 'total?')
    const history = await repo.recentConversation(u, { limit: 10, since: new Date(now.getTime() - 60_000), excludeId: text.id, now })
    const kept = await repo.attachmentFor(photo.id, now)
    expect(kept).toMatchObject({ sizeBytes: 5 })
    expect(history).toEqual([
      { id: photo.id, direction: 'inbound', body: '', attachment: { id: kept!.id, sizeBytes: 5 } },
      { id: doc.id, direction: 'inbound', body: 'summarise' }, // its file expired
    ])
    const loaded = await repo.loadAttachments([kept!.id])
    expect(loaded.get(kept!.id)).toEqual({ kind: 'image', mimeType: 'image/jpeg', data: bytes })

    expect(await repo.deleteExpiredAttachments(now)).toBeGreaterThanOrEqual(1)
    expect(await repo.attachmentFor(doc.id, new Date(0))).toBeNull()
    expect(await repo.attachmentFor(photo.id, now)).not.toBeNull()
  })
})
