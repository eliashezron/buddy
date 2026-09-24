import { FAILURE_REPLY, isTransientModelError, runAgent, type ActionLog, type CreateMessage } from '@wa/agent'
import type { AnyTool, Logger } from '@wa/core'
import type { Repo } from '@wa/db'
import {
  GraphApiError,
  OutsideServiceWindowError,
  toWhatsAppText,
  type InboundMessage,
  type Sender,
  type StatusUpdate,
  type WebhookEvent,
  type WhatsAppClient,
} from '@wa/whatsapp'
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
  client: WhatsAppClient
  sender: Sender
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

/** What we store as the body. Content only; never logged. */
function bodyOf(m: InboundMessage): string | null {
  return m.text ?? m.reply?.title ?? m.media?.caption ?? null
}

export function createInboundHandler(deps: InboundDeps) {
  const { repo, sender, client, logger } = deps
  const perUser = new KeyedLock()

  async function reply(userId: string, waId: string, text: string) {
    try {
      const ids = await sender.sendText(waId, text)
      const sentAt = new Date()
      for (const id of ids) await repo.insertOutboundMessage({ userId, waMessageId: id, body: text, sentAt })
    } catch (err) {
      if (err instanceof OutsideServiceWindowError) {
        // No templates yet (whatsapp-notes.md §7). Dropping is logged, never silent.
        logger.warn({ userId }, 'reply dropped: service window closed')
        return
      }
      if (err instanceof GraphApiError && !err.retryable) {
        logger.error({ userId, status: err.status, code: err.code }, 'reply rejected by graph api')
        return
      }
      throw err
    }
  }

  async function handleMessage(m: InboundMessage, job: JobInfo) {
    const log = logger.child({ wamid: m.id, type: m.type })
    const user = await repo.upsertUserOnInbound({
      waId: m.from,
      at: new Date(m.timestamp * 1000),
      timezone: deps.defaultTimezone,
      ...(m.contactName ? { displayName: m.contactName } : {}),
    })
    const stored = await repo.insertInboundMessage({
      userId: user.id,
      waMessageId: m.id,
      type: m.type,
      body: bodyOf(m),
      sentAt: new Date(m.timestamp * 1000),
    })
    if (!stored.isNew && (await repo.hasCompletedRun(stored.id))) {
      log.info('duplicate delivery, already handled')
      return
    }

    if (m.type !== 'text' || !m.text) {
      log.info('unsupported message type')
      await reply(user.id, user.waId, UNSUPPORTED_REPLIES[m.type] ?? DEFAULT_UNSUPPORTED)
      return
    }

    // Read receipt + typing indicator while the agent works. Best-effort.
    client.markRead(m.id, { typing: true }).catch((err: unknown) => log.warn({ err }, 'markRead failed'))

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
        history: history.map((h) => ({ role: h.direction === 'inbound' ? 'user' : 'assistant', text: h.body })),
        message: { text: m.text, ...(m.forwarded ? { forwarded: true } : {}) },
      })
    } catch (err) {
      await repo.finishRun(runId, { status: 'failed', inputTokens: 0, outputTokens: 0, error: String(err) })
      const retry = !job.finalAttempt && isTransientModelError(err)
      log.error({ err, runId, retry }, 'agent run failed')
      if (retry) throw err
      await reply(user.id, user.waId, FAILURE_REPLY)
      return
    }

    log.info(
      { runId, status: result.status, tools: result.toolCalls.map((t) => `${t.name}:${t.outcome}`), ...result.usage },
      'agent run finished',
    )
    try {
      await reply(user.id, user.waId, toWhatsAppText(result.reply))
    } catch (err) {
      await repo.finishRun(runId, { ...result.usage, status: 'failed', error: 'reply send failed' })
      throw err
    }
    await repo.finishRun(runId, { ...result.usage, status: result.status })
  }

  async function handleStatus(s: StatusUpdate) {
    const applied = await repo.applyStatus({ waMessageId: s.id, status: s.status, errorCodes: s.errorCodes })
    if (s.status === 'failed') logger.error({ wamid: s.id, errorCodes: s.errorCodes }, 'outbound message failed')
    else logger.debug({ wamid: s.id, status: s.status, applied }, 'status update')
  }

  return async function handle(event: WebhookEvent, job: JobInfo = { finalAttempt: true }) {
    if (event.kind === 'status') return handleStatus(event.status)
    // One conversation at a time per user, so quick follow-ups see earlier replies.
    return perUser.run(event.message.from, () => handleMessage(event.message, job))
  }
}
