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
})
