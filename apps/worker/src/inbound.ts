import { FAILURE_REPLY, isTransientModelError, runAgent, type ActionLog, type CreateMessage } from '@wa/agent'
import {
  ChannelSendError,
  type AnyTool,
  type Channel,
  type ChannelEvent,
  type ChannelName,
  type InboundMessage,
  type Logger,
  type StatusUpdate,
} from '@wa/core'
import type { Repo } from '@wa/db'
import { KeyedLock } from './lock.js'

export type InboundRepo = Pick<
  Repo,
  | 'upsertUserOnInbound'
  | 'insertInboundMessage'
  | 'hasCompletedRun'
  | 'insertOutboundMessage'
  | 'applyStatus'
  | 'recentConversation'
  | 'createRun'
  | 'finishRun'
  | 'createAction'
  | 'updateAction'
>

export interface InboundDeps {
  repo: InboundRepo
  /** Outbound side of each enabled channel. Events for a missing channel fail loudly. */
  channels: Partial<Record<ChannelName, Channel>>
  createMessage: CreateMessage
  model: string
  tools: AnyTool[]
  logger: Logger
  defaultTimezone: string
  historyLimit?: number
  historyWindowMs?: number
}

export interface JobInfo {
  /** True when BullMQ will not retry this job again. */
  finalAttempt: boolean
}

export const UNSUPPORTED_REPLIES: Record<string, string> = {
  audio: "I can't listen to voice notes yet. It's coming soon. For now, please type your request.",
  image: "I can't look at images yet. Please describe what you need in a message.",
  document: "I can't open documents yet. Please paste the text or tell me what you need.",
  video: "I can't watch videos yet. Please describe what you need in a message.",
  interactive: 'That button is no longer active. Tell me what you need and I will take it from there.',
  button: 'That button is no longer active. Tell me what you need and I will take it from there.',
}
const DEFAULT_UNSUPPORTED = "I can't read that type of message yet. Please send your request as text."

export function welcomeText(name?: string): string {
  return [
    `Hi${name ? ` ${name}` : ''}! I'm your task assistant.`,
    '',
    'Ask me to look things up (prices, opening hours, news, places, how-tos) or send me a link to summarise. Calendar, email and Notion are coming soon.',
    '',
    'I only see the messages you send me here.',
  ].join('\n')
}

/** What we store as the body. Content only; never logged. */
function bodyOf(m: InboundMessage): string | null {
  // Empty strings (e.g. a bare /start) are stored as null so they never become history.
  const body = m.text ?? m.reply?.title ?? m.media?.caption ?? null
  return body?.trim() ? body : null
}

export function createInboundHandler(deps: InboundDeps) {
  const { repo, logger } = deps
  const perUser = new KeyedLock()

  function channelFor(name: ChannelName): Channel {
    const channel = deps.channels[name]
    if (!channel) throw new Error(`channel not enabled: ${name}`)
    return channel
  }

  /** Sends Markdown through the user's channel. Permanent failures (closed window, blocked bot) are logged and dropped. */
  async function reply(user: { id: string; channel: ChannelName; externalId: string }, markdown: string) {
    try {
      const ids = await channelFor(user.channel).sendText(user.externalId, markdown)
      const sentAt = new Date()
      for (const id of ids) {
        await repo.insertOutboundMessage({ userId: user.id, channel: user.channel, externalMessageId: id, body: markdown, sentAt })
      }
    } catch (err) {
      if (err instanceof ChannelSendError && err.permanent) {
        logger.warn({ userId: user.id, channel: user.channel, err }, 'reply dropped')
        return
      }
      throw err
    }
  }

  async function handleMessage(m: InboundMessage, job: JobInfo) {
    // platformMessageId, not id: Telegram ids embed the chat id, which is the user's Telegram id.
    const log = logger.child({ channel: m.channel, msgId: m.platformMessageId, type: m.type })
    const channel = channelFor(m.channel)
    const user = await repo.upsertUserOnInbound({
      channel: m.channel,
      externalId: m.from,
      at: new Date(m.timestamp * 1000),
      timezone: deps.defaultTimezone,
      ...(m.contactName ? { displayName: m.contactName } : {}),
    })
    const stored = await repo.insertInboundMessage({
      userId: user.id,
      channel: m.channel,
      externalMessageId: m.id,
      type: m.type,
      body: bodyOf(m),
      sentAt: new Date(m.timestamp * 1000),
    })
    if (!stored.isNew && (await repo.hasCompletedRun(stored.id))) {
      log.info('duplicate delivery, already handled')
      return
    }

    // Bot commands (Telegram). /start and /help get a fixed welcome; anything else
    // with arguments is treated as a normal request.
    let text = m.text
    if (m.type === 'command') {
      if (m.command === 'start' || m.command === 'help' || !m.text) {
        await reply(user, welcomeText(user.displayName ?? undefined))
        return
      }
      text = m.text
    } else if (m.type !== 'text') {
      text = undefined
    }
    if (!text) {
      log.info('unsupported message type')
      await reply(user, UNSUPPORTED_REPLIES[m.type] ?? DEFAULT_UNSUPPORTED)
      return
    }

    const history = await repo.recentConversation(user.id, {
      limit: deps.historyLimit ?? 12,
      since: new Date(Date.now() - (deps.historyWindowMs ?? 6 * 60 * 60_000)),
      excludeId: stored.id,
    })
    const runId = await repo.createRun({ userId: user.id, triggerMessageId: stored.id, model: deps.model })
    const actions: ActionLog = {
      create: (a) => repo.createAction({ ...a, userId: user.id, runId }),
      update: (id, patch) => repo.updateAction(id, patch),
    }

    // Read receipt / typing indicator while the agent works. Best-effort.
    const stopTyping = channel.startTyping(m)
    const startedAt = Date.now()
    let result
    try {
      result = await runAgent({
        createMessage: deps.createMessage,
        model: deps.model,
        tools: deps.tools,
        actions,
        logger: log.child({ runId }),
        runId,
        user: { id: user.id, timezone: user.timezone, ...(user.displayName ? { name: user.displayName } : {}) },
        channel: m.channel,
        history: history.map((h) => ({ role: h.direction === 'inbound' ? 'user' : 'assistant', text: h.body })),
        message: { text, ...(m.forwarded ? { forwarded: true } : {}) },
      })
    } catch (err) {
      stopTyping()
      await repo.finishRun(runId, { status: 'failed', inputTokens: 0, outputTokens: 0, error: String(err) })
      const retry = !job.finalAttempt && isTransientModelError(err)
      log.error({ err, runId, retry }, 'agent run failed')
      if (retry) throw err
      await reply(user, FAILURE_REPLY)
      return
    }
    stopTyping()

    log.info(
      {
        runId,
        status: result.status,
        tools: result.toolCalls.map((t) => `${t.name}:${t.outcome}`),
        durationMs: Date.now() - startedAt,
        ...result.usage,
      },
      'agent run finished',
    )
    try {
      await reply(user, result.reply)
    } catch (err) {
      await repo.finishRun(runId, { ...result.usage, status: 'failed', error: 'reply send failed' })
      throw err
    }
    await repo.finishRun(runId, { ...result.usage, status: result.status })
  }

  async function handleStatus(s: StatusUpdate) {
    const applied = await repo.applyStatus({
      channel: s.channel,
      externalMessageId: s.id,
      status: s.status,
      errorCodes: s.errorCodes,
    })
    if (s.status === 'failed') logger.error({ channel: s.channel, msgId: s.id, errorCodes: s.errorCodes }, 'outbound message failed')
    else logger.debug({ channel: s.channel, msgId: s.id, status: s.status, applied }, 'status update')
  }

  return async function handle(event: ChannelEvent, job: JobInfo = { finalAttempt: true }) {
    if (event.kind === 'status') return handleStatus(event.status)
    // One conversation at a time per user, so quick follow-ups see earlier replies.
    const { channel, from } = event.message
    return perUser.run(`${channel}:${from}`, () => handleMessage(event.message, job))
  }
}
