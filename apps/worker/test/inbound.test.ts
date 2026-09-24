import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FAILURE_REPLY, type CreateMessage } from '@wa/agent'
import { createLogger, defineTool } from '@wa/core'
import { createSender, FakeWhatsAppClient, parseWebhook, type WebhookEvent } from '@wa/whatsapp'
import { createInboundHandler, UNSUPPORTED_REPLIES, type InboundRepo } from '../src/inbound.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const logger = createLogger({ name: 'test', level: 'silent' })

function fixtureEvents(name: string, rebase = true): WebhookEvent[] {
  const file = path.resolve(import.meta.dirname, `../../../fixtures/${name}.json`)
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(file, 'utf8'))
  const events = parseWebhook(payload).events
  if (rebase) {
    for (const e of events) if (e.kind === 'message') e.message.timestamp = Math.floor(Date.now() / 1000)
  }
  return events
}

/** In-memory stand-in for @wa/db's repo, enough to exercise the handler's logic. */
function memoryRepo() {
  const users = new Map<string, { id: string; waId: string; displayName: string | null; timezone: string; lastInboundAt: Date | null; createdAt: Date }>()
  const messages: { id: string; userId: string; waMessageId: string; direction: string; body: string | null; status?: string }[] = []
  const runs = new Map<string, { status: string; triggerMessageId: string }>()
  const actions: { id: string; tool: string; status: string }[] = []
  let seq = 0
  const repo: InboundRepo = {
    async upsertUserOnInbound({ waId, displayName, at, timezone }) {
      let u = users.get(waId)
      if (!u) {
        u = { id: `user_${++seq}`, waId, displayName: displayName ?? null, timezone, lastInboundAt: at, createdAt: new Date() }
        users.set(waId, u)
      } else if (!u.lastInboundAt || u.lastInboundAt < at) u.lastInboundAt = at
      return u
    },
    async insertInboundMessage(m) {
      const existing = messages.find((x) => x.waMessageId === m.waMessageId)
      if (existing) return { id: existing.id, isNew: false }
      const id = `msg_${++seq}`
      messages.push({ id, userId: m.userId, waMessageId: m.waMessageId, direction: 'inbound', body: m.body })
      return { id, isNew: true }
    },
    async hasCompletedRun(messageId) {
      return [...runs.values()].some((r) => r.triggerMessageId === messageId && (r.status === 'succeeded' || r.status === 'refused'))
    },
    async insertOutboundMessage(m) {
      messages.push({ id: `msg_${++seq}`, userId: m.userId, waMessageId: m.waMessageId, direction: 'outbound', body: m.body, status: 'sent' })
    },
    async applyStatus({ waMessageId, status }) {
      const m = messages.find((x) => x.waMessageId === waMessageId)
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
      actions.push({ id, tool: a.tool, status: a.status })
      return id
    },
    async updateAction(id, patch) {
      actions.find((a) => a.id === id)!.status = patch.status
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

function setup(createMessage: CreateMessage) {
  const mem = memoryRepo()
  const client = new FakeWhatsAppClient()
  const sender = createSender({ client, getLastInboundAt: async (waId) => mem.users.get(waId)?.lastInboundAt ?? null })
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
    client,
    sender,
    createMessage,
    model: 'claude-opus-5',
    tools: [noop],
    logger,
    defaultTimezone: 'Africa/Kampala',
  })
  return { ...mem, client, handle }
}

describe('inbound handler', () => {
  it('runs the agent on a text message and replies in WhatsApp formatting', async () => {
    const t = setup(async () => reply('**Booked** for tomorrow'))
    for (const e of fixtureEvents('book-meeting')) await t.handle(e)
    expect(t.client.calls[0]).toEqual({ method: 'markRead', messageId: 'wamid.TEST_BOOK_MEETING_0001', typing: true })
    expect(t.client.sent).toEqual([{ method: 'sendText', to: '256770000001', body: '*Booked* for tomorrow' }])
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
    expect(t.client.sent).toHaveLength(1)
  })

  it('retries a failed run: rethrows before the final attempt, apologises on the last', async () => {
    let calls = 0
    const t = setup(async () => {
      calls++
      throw new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error' } }, 'overloaded', new Headers())
    })
    const [event] = fixtureEvents('book-meeting')
    await expect(t.handle(event!, { finalAttempt: false })).rejects.toThrow('overloaded')
    expect(t.client.sent).toEqual([])
    await t.handle(event!, { finalAttempt: true })
    expect(calls).toBe(2)
    expect(t.client.sent.map((c) => c.body)).toEqual([FAILURE_REPLY])
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
    expect(t.client.sent.map((c) => c.body)).toEqual([FAILURE_REPLY])
  })

  it('answers voice notes and stale buttons without calling the model', async () => {
    const t = setup(async () => {
      throw new Error('model must not be called')
    })
    for (const e of fixtureEvents('voice-note')) await t.handle(e)
    for (const e of fixtureEvents('button-approval')) await t.handle(e)
    expect(t.client.sent.map((c) => c.body)).toEqual([UNSUPPORTED_REPLIES.audio, UNSUPPORTED_REPLIES.interactive])
  })

  it('applies delivery statuses without running the agent', async () => {
    const t = setup(async () => {
      throw new Error('model must not be called')
    })
    for (const e of fixtureEvents('book-meeting')) {
      await setup(async () => reply('x')).handle(e)
    }
    for (const e of fixtureEvents('status-update')) await t.handle(e)
    expect(t.client.calls).toEqual([])
  })

  it('does not reply outside the 24 h window (fixture timestamps are days old)', async () => {
    const t = setup(async () => reply('late'))
    for (const e of fixtureEvents('book-meeting', false)) await t.handle(e)
    expect(t.client.sent).toEqual([])
  })
})
