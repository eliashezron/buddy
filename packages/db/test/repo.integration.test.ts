import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createRepo, type Repo } from '../src/index.js'

// Runs against a real, migrated Postgres when TEST_DATABASE_URL is set (CI sets it).
const url = process.env.TEST_DATABASE_URL
const suffix = Math.random().toString(36).slice(2, 8)

describe.skipIf(!url)('repo (postgres)', () => {
  let repo: Repo
  let close: () => Promise<void>
  beforeAll(() => {
    const db = createDb(url!, { max: 2 })
    repo = createRepo(db.db)
    close = db.close
  })
  afterAll(() => close())

  it('never moves last_inbound_at backwards (webhooks are unordered)', async () => {
    const waId = `2567${suffix}01`
    await repo.upsertUserOnInbound({ channel: 'whatsapp', externalId: waId, at: new Date('2026-09-24T10:00:00Z'), timezone: 'Africa/Kampala' })
    await repo.upsertUserOnInbound({ channel: 'whatsapp', externalId: waId, at: new Date('2026-09-24T09:00:00Z'), timezone: 'Africa/Kampala' })
    expect(await repo.getLastInboundAt('whatsapp', waId)).toEqual(new Date('2026-09-24T10:00:00Z'))
  })

  it('deduplicates inbound messages on wa_message_id', async () => {
    const user = await repo.upsertUserOnInbound({ channel: 'whatsapp', externalId: `2567${suffix}02`, at: new Date(), timezone: 'Africa/Kampala' })
    const m = { userId: user.id, channel: 'whatsapp' as const, externalMessageId: `wamid.IT_${suffix}`, type: 'text', body: 'hi', sentAt: new Date() }
    const first = await repo.insertInboundMessage(m)
    const second = await repo.insertInboundMessage(m)
    expect(first.isNew).toBe(true)
    expect(second).toEqual({ id: first.id, isNew: false })
    expect(await repo.hasCompletedRun(first.id)).toBe(false)
    const runId = await repo.createRun({ userId: user.id, triggerMessageId: first.id, model: 'm' })
    await repo.finishRun(runId, { status: 'succeeded', inputTokens: 1, outputTokens: 1 })
    expect(await repo.hasCompletedRun(first.id)).toBe(true)
  })

  it('keeps the same external id apart across channels', async () => {
    const id = `55${suffix}`
    const wa = await repo.upsertUserOnInbound({ channel: 'whatsapp', externalId: id, at: new Date(), timezone: 'Africa/Kampala' })
    const tg = await repo.upsertUserOnInbound({ channel: 'telegram', externalId: id, at: new Date(), timezone: 'Africa/Kampala' })
    expect(wa.id).not.toBe(tg.id)
    const a = await repo.insertInboundMessage({ userId: tg.id, channel: 'telegram', externalMessageId: `${id}:1`, type: 'text', body: 'x', sentAt: new Date() })
    const b = await repo.insertInboundMessage({ userId: wa.id, channel: 'whatsapp', externalMessageId: `${id}:1`, type: 'text', body: 'x', sentAt: new Date() })
    expect(a.isNew && b.isNew).toBe(true)
  })

  it('ignores out-of-order status regressions', async () => {
    const user = await repo.upsertUserOnInbound({ channel: 'whatsapp', externalId: `2567${suffix}03`, at: new Date(), timezone: 'Africa/Kampala' })
    const externalMessageId = `wamid.OUT_${suffix}`
    await repo.insertOutboundMessage({ userId: user.id, channel: 'whatsapp', externalMessageId, body: 'x', sentAt: new Date() })
    expect(await repo.applyStatus({ channel: 'whatsapp', externalMessageId, status: 'read', errorCodes: [] })).toBe(true)
    expect(await repo.applyStatus({ channel: 'whatsapp', externalMessageId, status: 'delivered', errorCodes: [] })).toBe(false)
  })
})
