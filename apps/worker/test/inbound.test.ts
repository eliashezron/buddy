import { readFileSync } from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FAILURE_REPLY, type CreateMessage } from '@wa/agent'
import { createLogger, defineTool, type ChannelEvent, type ChannelName } from '@wa/core'
import { createTelegramChannel, FakeTelegramClient, parseTelegramUpdate, TelegramApiError } from '@wa/telegram'
import { createWhatsAppChannel, FakeWhatsAppClient, parseWebhook } from '@wa/whatsapp'
import { createInboundHandler, UNSUPPORTED_REPLIES, welcomeText, type InboundRepo } from '../src/inbound.js'

const logger = createLogger({ name: 'test', level: 'silent' })

function loadFixture(name: string) {
  const file = path.resolve(import.meta.dirname, `../../../fixtures/${name}.json`)
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(file, 'utf8'))
  return payload
}

/** Parses a WhatsApp or Telegram fixture; `rebase` moves timestamps to now (keeps the 24 h window open). */
function fixtureEvents(name: string, rebase = true): ChannelEvent[] {
  const payload = loadFixture(name)
  const events = 'update_id' in payload ? parseTelegramUpdate(payload).events : parseWebhook(payload).events
  if (rebase) for (const e of events) if (e.kind === 'message') e.message.timestamp = Math.floor(Date.now() / 1000)
  return events
}

/** In-memory stand-in for @wa/db's repo, enough to exercise the handler's logic. */
function memoryRepo() {
  type U = { id: string; channel: ChannelName; externalId: string; displayName: string | null; timezone: string; lastInboundAt: Date | null; createdAt: Date }
  const users = new Map<string, U>()
  const messages: { id: string; userId: string; channel: string; externalMessageId: string; direction: string; body: string | null; status?: string }[] = []
  const runs = new Map<string, { status: string; triggerMessageId: string }>()
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
    async createAction() {
      return `act_${++seq}`
    },
    async updateAction() {},
  }
  return { repo, users, messages, runs }
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

function setup(createMessage: CreateMessage) {
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
      telegram: createTelegramChannel({ client: tg }),
    },
    createMessage,
    model: 'claude-opus-5',
    tools: [noop],
    logger,
    defaultTimezone: 'Africa/Kampala',
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
    expect(out).toMatchObject({ channel: 'telegram', externalMessageId: '555000111:1' })
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
    expect(t.messages.find((m) => m.externalMessageId === '555000111:40')?.body).toBeNull()
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
