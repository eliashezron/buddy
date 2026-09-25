import { readFileSync } from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FAILURE_REPLY, type CreateMessage } from '@wa/agent'
import { createLogger, defineTool, NeedsConnectionError, type Capability, type ChannelEvent, type ChannelName, type ConnectionEvent } from '@wa/core'
import { createTelegramChannel, FakeTelegramClient, parseTelegramUpdate, TelegramApiError } from '@wa/telegram'
import { createWhatsAppChannel, FakeWhatsAppClient, parseWebhook } from '@wa/whatsapp'
import { createInboundHandler, UNSUPPORTED_REPLIES, welcomeText, type Connectors, type InboundRepo } from '../src/inbound.js'

const logger = createLogger({ name: 'test', level: 'silent' })

function loadFixture(name: string) {
  const file = path.resolve(import.meta.dirname, `../../../fixtures/${name}.json`)
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(file, 'utf8'))
  return payload
}

/** Parses a WhatsApp or Telegram fixture; `rebase` moves timestamps to now (keeps the 24 h window open). */
function fixtureEvents(name: string, rebase = true): ChannelEvent[] {
  const payload = loadFixture(name)
  const events = 'update_id' in payload ? parseTelegramUpdate(payload, { botId: '1' }).events : parseWebhook(payload).events
  if (rebase) for (const e of events) if (e.kind === 'message') e.message.timestamp = Math.floor(Date.now() / 1000)
  return events
}

/** In-memory stand-in for @wa/db's repo, enough to exercise the handler's logic. */
function memoryRepo() {
  type U = { id: string; channel: ChannelName; externalId: string; displayName: string | null; timezone: string; lastInboundAt: Date | null; createdAt: Date }
  const users = new Map<string, U>()
  const messages: { id: string; userId: string; channel: string; externalMessageId: string; direction: string; body: string | null; status?: string }[] = []
  const runs = new Map<string, { status: string; triggerMessageId: string }>()
  const actions: {
    id: string; userId: string; runId: string; tool: string; risk: string; status: string
    input: unknown; result: unknown; undoExpiresAt: Date | null; createdAt: Date
  }[] = []
  let seq = 0
  const key = (channel: string, id: string) => `${channel}:${id}`
  const repo: InboundRepo = {
    async upsertUserOnInbound({ channel, externalId, displayName, at, timezone }) {
      let u = users.get(key(channel, externalId))
      if (!u) {
        u = { id: `user_${++seq}`, channel, externalId, displayName: displayName ?? null, timezone, lastInboundAt: at, createdAt: new Date() }
        users.set(key(channel, externalId), u)
      } else if (!u.lastInboundAt || u.lastInboundAt < at) u.lastInboundAt = at
      return u
    },
    async insertInboundMessage(m) {
      const existing = messages.find((x) => x.channel === m.channel && x.externalMessageId === m.externalMessageId)
      if (existing) return { id: existing.id, isNew: false }
      const id = `msg_${++seq}`
      messages.push({ id, userId: m.userId, channel: m.channel, externalMessageId: m.externalMessageId, direction: 'inbound', body: m.body })
      return { id, isNew: true }
    },
    async hasCompletedRun(messageId) {
      return [...runs.values()].some((r) => r.triggerMessageId === messageId && (r.status === 'succeeded' || r.status === 'refused'))
    },
    async insertOutboundMessage(m) {
      messages.push({ id: `msg_${++seq}`, userId: m.userId, channel: m.channel, externalMessageId: m.externalMessageId, direction: 'outbound', body: m.body, status: 'sent' })
    },
    async applyStatus({ channel, externalMessageId, status }) {
      const m = messages.find((x) => x.channel === channel && x.externalMessageId === externalMessageId)
      if (!m) return false
      m.status = status
      return true
    },
    async recentConversation(userId, { excludeId }) {
      return messages
        .filter((m) => m.userId === userId && m.id !== excludeId && m.body)
        .map((m) => ({ direction: m.direction as 'inbound' | 'outbound', body: m.body! }))
    },
    async createRun({ triggerMessageId }) {
      const id = `run_${++seq}`
      runs.set(id, { status: 'running', triggerMessageId })
      return id
    },
    async finishRun(id, patch) {
      runs.get(id)!.status = patch.status
    },
    async createAction(a) {
      const id = `act_${++seq}`
      actions.push({ id, userId: a.userId, runId: a.runId, tool: a.tool, risk: a.risk, status: a.status, input: a.input, result: null, undoExpiresAt: null, createdAt: new Date(Date.now() + seq) })
      return id
    },
    async updateAction(id, patch) {
      const a = actions.find((x) => x.id === id)
      if (a) Object.assign(a, patch)
    },
    async getUserById(id) {
      return [...users.values()].find((u) => u.id === id) ?? null
    },
    async getMessageById(id) {
      const m = messages.find((x) => x.id === id)
      return m ? ({ ...m, type: 'text', status: m.status ?? null, errorCodes: null, sentAt: new Date(), createdAt: new Date() } as never) : null
    },
    async latestUndoableAction(userId, now) {
      const open = actions.filter((a) => a.userId === userId && a.risk === 'low_write' && a.status === 'succeeded' && a.undoExpiresAt && a.undoExpiresAt > now)
      return (open.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] as never) ?? null
    },
  }
  return { repo, users, messages, runs, actions }
}

const reply = (text: string) =>
  ({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Beta.Messages.BetaMessage

function setup(createMessage: CreateMessage, opts: { connectors?: Connectors; tools?: ReturnType<typeof defineTool>[] } = {}) {
  const mem = memoryRepo()
  const wa = new FakeWhatsAppClient()
  const tg = new FakeTelegramClient()
  const noop = defineTool({
    name: 'web_search',
    description: 'search',
    risk: 'read',
    input: z.object({ query: z.string() }),
    preview: () => '',
    execute: async () => ({ ok: true }),
  })
  const handle = createInboundHandler({
    repo: mem.repo,
    channels: {
      whatsapp: createWhatsAppChannel({
        client: wa,
        getLastInboundAt: async (id) => mem.users.get(`whatsapp:${id}`)?.lastInboundAt ?? null,
      }),
      telegram: createTelegramChannel({ client: tg, botId: '1' }),
    },
    createMessage,
    model: 'claude-opus-5',
    tools: (opts.tools ?? [noop]) as never,
    logger,
    defaultTimezone: 'Africa/Kampala',
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
  })
  return { ...mem, wa, tg, handle }
}

describe('inbound handler: WhatsApp', () => {
  it('runs the agent on a text message and replies in WhatsApp formatting', async () => {
    const t = setup(async () => reply('**Booked** for tomorrow'))
    for (const e of fixtureEvents('book-meeting')) await t.handle(e)
    expect(t.wa.calls[0]).toEqual({ method: 'markRead', messageId: 'wamid.TEST_BOOK_MEETING_0001', typing: true })
    expect(t.wa.sent).toEqual([{ method: 'sendText', to: '256770000001', body: '*Booked* for tomorrow' }])
    expect([...t.runs.values()][0]?.status).toBe('succeeded')
    expect(t.messages.filter((m) => m.direction === 'outbound')).toHaveLength(1)
  })

  it('handles a redelivered message only once', async () => {
    let calls = 0
    const t = setup(async () => (calls++, reply('ok')))
    const [event] = fixtureEvents('book-meeting')
    await t.handle(event!)
    await t.handle(event!)
    expect(calls).toBe(1)
    expect(t.wa.sent).toHaveLength(1)
  })

  it('retries a transient failure: rethrows before the final attempt, apologises on the last', async () => {
    let calls = 0
    const t = setup(async () => {
      calls++
      throw new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error' } }, 'overloaded', new Headers())
    })
    const [event] = fixtureEvents('book-meeting')
    await expect(t.handle(event!, { finalAttempt: false })).rejects.toThrow('overloaded')
    expect(t.wa.sent).toEqual([])
    await t.handle(event!, { finalAttempt: true })
    expect(calls).toBe(2)
    expect(t.wa.sent.map((c) => c.body)).toEqual([FAILURE_REPLY])
  })

  it('does not retry permanent model errors such as a bad API key', async () => {
    let calls = 0
    const t = setup(async () => {
      calls++
      throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())
    })
    const [event] = fixtureEvents('book-meeting')
    await t.handle(event!, { finalAttempt: false })
    expect(calls).toBe(1)
    expect(t.wa.sent.map((c) => c.body)).toEqual([FAILURE_REPLY])
  })

  it('answers voice notes and stale buttons without calling the model', async () => {
    const t = setup(async () => {
      throw new Error('model must not be called')
    })
    for (const e of fixtureEvents('voice-note')) await t.handle(e)
    for (const e of fixtureEvents('button-approval')) await t.handle(e)
    expect(t.wa.sent.map((c) => c.body)).toEqual([UNSUPPORTED_REPLIES.audio, UNSUPPORTED_REPLIES.interactive])
  })

  it('applies delivery statuses without running the agent', async () => {
    const t = setup(async () => {
      throw new Error('model must not be called')
    })
    for (const e of fixtureEvents('status-update')) await t.handle(e)
    expect(t.wa.calls).toEqual([])
  })

  it('does not reply outside the 24 h window (fixture timestamps are days old)', async () => {
    const t = setup(async () => reply('late'))
    for (const e of fixtureEvents('book-meeting', false)) await t.handle(e)
    expect(t.wa.sent).toEqual([])
  })
})

describe('inbound handler: Telegram', () => {
  it('runs the agent and replies as Telegram HTML to the chat', async () => {
    const t = setup(async () => reply('**1 USD** ≈ 3,700 UGX <today>'))
    for (const e of fixtureEvents('telegram-text')) await t.handle(e)
    expect(t.tg.calls[0]).toEqual({ method: 'sendChatAction', chatId: '555000111', action: 'typing' })
    expect(t.tg.sent).toEqual([
      { method: 'sendMessage', chatId: '555000111', text: '<b>1 USD</b> ≈ 3,700 UGX &lt;today&gt;', html: true },
    ])
    const out = t.messages.find((m) => m.direction === 'outbound')
    expect(out).toMatchObject({ channel: 'telegram', externalMessageId: '1:555000111:1' })
  })

  it('never applies the WhatsApp service window: old Telegram messages still get replies', async () => {
    const t = setup(async () => reply('ok'))
    for (const e of fixtureEvents('telegram-text', false)) await t.handle(e)
    expect(t.tg.sent).toHaveLength(1)
  })

  it('answers /start with the welcome and no model call', async () => {
    const t = setup(async () => {
      throw new Error('model must not be called')
    })
    for (const e of fixtureEvents('telegram-start')) await t.handle(e)
    expect(t.tg.sent.map((c) => c.text)).toEqual([expect.stringContaining('Hi Elias!')])
    expect(welcomeText('Elias')).toContain("I'm your task assistant")
  })

  it('handles /start followed by a question without sending an empty turn to the model', async () => {
    const seen: unknown[] = []
    const t = setup(async (params) => {
      seen.push(...params.messages.map((m) => m.content))
      return reply('ok')
    })
    for (const e of [...fixtureEvents('telegram-start'), ...fixtureEvents('telegram-text')]) await t.handle(e)
    expect(seen.length).toBeGreaterThan(0)
    for (const content of seen) expect(typeof content === 'string' ? content.trim() : 'x').not.toBe('')
    expect(t.messages.find((m) => m.externalMessageId === '1:555000111:40')?.body).toBeNull()
    expect(t.tg.sent).toHaveLength(2)
  })

  it('treats forwarded Telegram messages as untrusted content', async () => {
    let prompt = ''
    const t = setup(async (params) => {
      prompt = String(params.messages.at(-1)?.content)
      return reply('It asks you to pay. I did nothing.')
    })
    for (const e of fixtureEvents('telegram-forwarded')) await t.handle(e)
    expect(prompt).toMatch(/^The user forwarded this message:\n<forwarded_content>/)
  })

  it('drops the reply when the user has blocked the bot, without retrying', async () => {
    const t = setup(async () => reply('ok'))
    t.tg.sendMessage = async () => {
      throw new TelegramApiError(403, 'Forbidden: bot was blocked by the user')
    }
    const [event] = fixtureEvents('telegram-text')
    await expect(t.handle(event!, { finalAttempt: false })).resolves.toBeUndefined()
  })

  it('keeps WhatsApp and Telegram users with the same id apart', async () => {
    const t = setup(async () => reply('ok'))
    for (const e of [...fixtureEvents('telegram-text'), ...fixtureEvents('book-meeting')]) await t.handle(e)
    expect([...t.users.values()].map((u) => u.channel).sort()).toEqual(['telegram', 'whatsapp'])
  })
})

describe('inbound handler: connectors', () => {
  const toolUse = (name: string, input: unknown) =>
    ({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 't1', name, input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }) as unknown as Anthropic.Beta.Messages.BetaMessage

  function calendarTool(connected: () => boolean) {
    return defineTool({
      name: 'calendar_list_events',
      description: 'calendar',
      risk: 'read',
      input: z.object({ from: z.string(), to: z.string() }),
      preview: () => '',
      async execute() {
        if (!connected()) throw new NeedsConnectionError(['calendar.read'], 'not_connected')
        return { ok: true, events: [{ title: 'Standup' }] }
      },
    })
  }

  function fakeConnectors() {
    const links: { userId: string; capabilities: Capability[]; triggerMessageId: string | null }[] = []
    const connectors: Connectors = {
      forUser: () => ({ credentials: { accessToken: async () => 'tok' }, connections: { list: async () => [], disconnect: async () => false } }),
      connectLink: async (input) => (links.push(input), { url: 'https://api.example/oauth/google/start?s=TOKEN' }),
    }
    return { connectors, links }
  }

  it('sends a system-written connect link after the reply when a tool needs access', async () => {
    const { connectors, links } = fakeConnectors()
    const script = [toolUse('calendar_list_events', { from: 'a', to: 'b' }), reply("I've sent you a secure link to connect your calendar.")]
    const t = setup(async () => script.shift()!, { connectors, tools: [calendarTool(() => false)] })
    for (const e of fixtureEvents('telegram-text')) await t.handle(e)

    expect(links).toEqual([{ userId: expect.any(String), capabilities: ['calendar.read'], triggerMessageId: expect.any(String) }])
    const texts = t.tg.sent.map((c) => c.text)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('see your calendar events')
    expect(texts[1]).toContain('https://api.example/oauth/google/start?s=TOKEN')
    expect(texts[1]).toContain('expires in 15 minutes')
  })

  it('after connecting: confirms, then re-runs the original request', async () => {
    const { connectors } = fakeConnectors()
    let isConnected = false
    const script = [
      toolUse('calendar_list_events', { from: 'a', to: 'b' }),
      reply('Link coming.'),
      toolUse('calendar_list_events', { from: 'a', to: 'b' }),
      reply('Tomorrow you have Standup at 9.'),
    ]
    const t = setup(async () => script.shift()!, { connectors, tools: [calendarTool(() => isConnected)] })
    const [event] = fixtureEvents('telegram-text')
    await t.handle(event!)
    const user = [...t.users.values()][0]!
    const trigger = t.messages.find((m) => m.direction === 'inbound')!

    isConnected = true
    const connected: ConnectionEvent = {
      kind: 'connection',
      id: 'h1',
      outcome: 'connected',
      userId: user.id,
      triggerMessageId: trigger.id,
      requested: ['calendar.read'],
      missing: [],
      account: 'elias@example.com',
    }
    await t.handle(connected)
    const texts = t.tg.sent.map((c) => c.text)
    expect(texts.at(-2)).toBe('✅ Connected Google Calendar (elias@example.com).')
    expect(texts.at(-1)).toBe('Tomorrow you have Standup at 9.')
  })

  it('says so when the user declines or unticks a permission, without re-running', async () => {
    const { connectors } = fakeConnectors()
    let calls = 0
    const t = setup(async () => (calls++, reply('x')), { connectors })
    for (const e of fixtureEvents('telegram-text')) await t.handle(e)
    const user = [...t.users.values()][0]!
    const base = { kind: 'connection' as const, id: 'h', userId: user.id, triggerMessageId: null, account: null }
    await t.handle({ ...base, outcome: 'denied', requested: ['gmail.read'], missing: [] })
    await t.handle({ ...base, id: 'h2', outcome: 'connected', requested: ['calendar.read', 'gmail.read'], missing: ['gmail.read'] })
    const texts = t.tg.sent.map((c) => c.text)
    expect(texts).toContain("No problem, I haven&#39;t connected anything. You can ask again whenever you like.".replace('&#39;', "'"))
    expect(texts.at(-1)).toContain("You didn't allow me to read your email")
    expect(calls).toBe(1)
  })

  it('undo: reverses the latest low_write action inside its 10-minute window, once', async () => {
    const undone: unknown[] = []
    const addEvent = defineTool({
      name: 'create_calendar_event',
      description: 'add',
      risk: 'low_write',
      input: z.object({ title: z.string() }),
      preview: ({ title }) => `Add "${title}"`,
      execute: async ({ title }) => ({ ok: true, eventId: 'ev1', title }),
      undo: async (result) => void undone.push(result),
    })
    const undoTool = defineTool({
      name: 'undo_last_action',
      description: 'undo',
      risk: 'low_write',
      input: z.object({}),
      preview: () => 'undo',
      execute: async (_i, ctx) => ctx.services.undo.undoLatest(),
    })
    const script = [
      toolUse('create_calendar_event', { title: 'Lunch with Kato' }),
      reply('Added.'),
      toolUse('undo_last_action', {}),
      reply('Removed it.'),
      toolUse('undo_last_action', {}),
      reply('Nothing to undo.'),
    ]
    const t = setup(async () => script.shift()!, { tools: [addEvent, undoTool] })
    const [first] = fixtureEvents('telegram-text')
    await t.handle(first!)
    // Any new message: ids differ.
    const next = (id: string) => {
      const [e] = fixtureEvents('telegram-text')
      if (e?.kind === 'message') e.message.id = id
      return e!
    }
    await t.handle(next('555000111:90'))
    expect(undone).toEqual([{ ok: true, eventId: 'ev1', title: 'Lunch with Kato' }])
    const created = t.actions.find((a) => a.tool === 'create_calendar_event')!
    expect(created.status).toBe('undone')

    await t.handle(next('555000111:91'))
    expect(undone).toHaveLength(1)
    const lastUndo = t.actions.filter((a) => a.tool === 'undo_last_action').at(-1)!
    expect(lastUndo.result).toMatchObject({ undone: false })
  })
})
