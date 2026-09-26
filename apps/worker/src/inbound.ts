import { FAILURE_REPLY, isTransientModelError, runAgent, type ActionLog, type CreateMessage } from '@wa/agent'
import {
  CAPABILITIES,
  ChannelSendError,
  noServices,
  MediaTooLargeError,
  parseApprovalButton,
  type AnyTool,
  type Capability,
  type Channel,
  type ChannelName,
  type ConnectionEvent,
  type ConnectionManager,
  type CredentialProvider,
  type InboundMessage,
  type Logger,
  type QueueEvent,
  type ReplyMode,
  type SpeechToText,
  type TextToSpeech,
  type Transcript,
  type StatusUpdate,
  type ToolServices,
  type UndoService,
} from '@wa/core'
import type { Repo, User } from '@wa/db'
import { createApprovals } from './approvals.js'
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
  | 'getUserById'
  | 'getMessageById'
  | 'latestUndoableActions'
  | 'decideApproval'
  | 'setMessageBody'
  | 'setReplyMode'
>

/** Google (or other) connectors for one user. Absent when no connector is configured. */
export interface Connectors {
  forUser(userId: string): { credentials: CredentialProvider; connections: ConnectionManager }
  /** One-time link. Google offers every capability; `needed` is what this request can't do without. */
  connectLink(input: { userId: string; needed: Capability[]; triggerMessageId: string | null }): Promise<{ url: string }>
}

export interface InboundDeps {
  repo: InboundRepo
  /** Outbound side of each enabled channel. Events for a missing channel fail loudly. */
  channels: Partial<Record<ChannelName, Channel>>
  createMessage: CreateMessage
  model: string
  tools: AnyTool[]
  logger: Logger
  defaultTimezone: string
  connectors?: Connectors
  /** Voice notes (PRD F2). Without it, voice notes get the "not yet" reply. */
  speech?: SpeechToText
  /** Voice replies (PRD F3). Without it, every reply is text. */
  tts?: TextToSpeech
  historyLimit?: number
  historyWindowMs?: number
  now?: () => Date
}

/** About 60 s of speech (PRD F3: voice replies stay under 60 s). */
export const MAX_SPOKEN_CHARS = 900

/**
 * The reply as it should sound: no URLs (never read a link aloud), no Markdown symbols,
 * list items as sentences, cut at a sentence boundary near 60 s.
 */
export function speakable(markdown: string): { text: string; hadLinks: boolean; truncated: boolean } {
  const hadLinks = /https?:\/\//.test(markdown)
  let text = markdown
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`~#>]/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  let truncated = false
  if (text.length > MAX_SPOKEN_CHARS) {
    const cut = text.slice(0, MAX_SPOKEN_CHARS)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
    text = end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
    truncated = true
  }
  return { text, hadLinks, truncated }
}

/** PRD F2: voice notes up to 5 minutes. WhatsApp reports no duration, so size is capped too. */
export const MAX_VOICE_SECONDS = 5 * 60
export const MAX_VOICE_BYTES = 16 * 1024 * 1024

export const VOICE_REPLIES = {
  tooLong: 'That voice note is over 5 minutes, which is more than I can take. Could you split it up, or type the main points?',
  unclear: "I couldn't make out that voice note. Could you try again somewhere quieter, or type it?",
  failed: 'Sorry, I had trouble with that voice note. Please try again in a moment, or type it.',
} as const

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
    'Ask me to look things up (prices, opening hours, news, places, how-tos) or send me a link to summarise. ' +
      "I can also check your calendar and email, find and read your Google Docs, Sheets and Slides, and create new ones: " +
      "I'll ask for access the first time you need it. Notion is coming soon.",
    '',
    'I only see the messages you send me here.',
  ].join('\n')
}

const labels = (caps: Capability[]) => {
  const l = [...new Set(caps)].map((c) => CAPABILITIES[c].label)
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`
}
const products = (caps: Capability[]) => [...new Set(caps.map((c) => CAPABILITIES[c].product))].join(' and ')

/**
 * The connect message: a button that opens the link, with the link also shown as text
 * for anyone who prefers to copy it. `historyText` leaves the one-time URL out, so it
 * is never stored and never reaches the model.
 */
export function connectLinkMessage(capabilities: Capability[], url: string): { text: string; historyText: string; label: string } {
  const historyText = [
    `🔐 To let me ${labels(capabilities)}, connect your Google account with the button below.`,
    '',
    "Google will list everything I can help with (calendar, email, Drive) so I don't have to ask again. " +
      'Untick anything you don\'t want; I only get what you leave ticked.',
    '',
    'The link works once and expires in 15 minutes. You can remove access any time: just say "disconnect Google".',
  ].join('\n')
  return { text: `${historyText}\n\nOr open this link:\n${url}`, historyText, label: 'Connect Google' }
}

/** The token counts agent_runs stores. Cache reads and writes are logged with the run. */
const storedUsage = (u: { inputTokens: number; outputTokens: number }) => ({ inputTokens: u.inputTokens, outputTokens: u.outputTokens })

/** What we store as the body. Content only; never logged. */
function bodyOf(m: InboundMessage): string | null {
  // Empty strings (e.g. a bare /start) are stored as null so they never become history.
  const body = m.text ?? m.reply?.title ?? m.media?.caption ?? null
  return body?.trim() ? body : null
}

export function createInboundHandler(deps: InboundDeps) {
  const { repo, logger } = deps
  const now = deps.now ?? (() => new Date())
  const perUser = new KeyedLock()
  const toolsByName = new Map(deps.tools.map((t) => [t.name, t]))

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

  async function sendConnectLink(user: User, capabilities: Capability[], triggerMessageId: string | null = null) {
    if (!deps.connectors) return
    // The system writes the link, never the model.
    const { url } = await deps.connectors.connectLink({ userId: user.id, needed: capabilities, triggerMessageId })
    const message = connectLinkMessage(capabilities, url)
    try {
      const ids = await channelFor(user.channel).sendLink(user.externalId, { text: message.text, label: message.label, url })
      // History keeps the text only: the one-time URL never reaches the model's context.
      const sentAt = new Date()
      for (const id of ids) {
        await repo.insertOutboundMessage({ userId: user.id, channel: user.channel, externalMessageId: id, body: message.historyText, sentAt })
      }
    } catch (err) {
      if (err instanceof ChannelSendError && err.permanent) {
        logger.warn({ userId: user.id, channel: user.channel, err }, 'connect link dropped')
        return
      }
      throw err
    }
  }

  const approvals = createApprovals({
    repo,
    toolsByName,
    channelFor: (user) => channelFor(user.channel),
    reply,
    servicesFor,
    sendConnectLink: (user, caps) => sendConnectLink(user, caps),
    logger,
    now,
  })

  function servicesFor(user: User): ToolServices {
    const base = deps.connectors?.forUser(user.id) ?? noServices()
    const services: ToolServices = {
      credentials: base.credentials,
      connections: base.connections,
      undo: undoFor(user),
      preferences: { setReplyMode: (mode) => repo.setReplyMode(user.id, mode) },
    }
    return services

    function undoFor(u: User): UndoService {
      return {
        async undoLatest() {
          const batch = await repo.latestUndoableActions(u.id, now())
          if (!batch.length) return { undone: false, reason: 'There is nothing I changed in the last 10 minutes to undo.' }
          const cannot = batch.find((a) => !toolsByName.get(a.tool)?.undo)
          if (cannot) return { undone: false, reason: `The last change (${cannot.tool}) can't be undone automatically.` }
          // Newest first, so dependent changes unwind in reverse order. Each is marked as it
          // goes, so a failure part-way leaves an accurate record of what was undone.
          const done: string[] = []
          for (const action of batch) {
            const tool = toolsByName.get(action.tool)!
            await tool.undo!(action.result, {
              userId: u.id,
              runId: action.runId ?? 'undo',
              actionId: action.id,
              timezone: u.timezone,
              now: now(),
              logger: logger.child({ tool: tool.name, actionId: action.id, undo: true }),
              services,
            })
            await repo.updateAction(action.id, { status: 'undone' })
            done.push(tool.preview(action.input))
          }
          return { undone: true, description: done.join('; ') }
        },
      }
    }
  }

  /** Runs the agent on `text` for `user` and replies; sends a connect link if a tool needed one. */
  async function runAndReply(opts: {
    user: User
    triggerMessageId: string
    text: string
    forwarded?: boolean
    typingFor?: InboundMessage
    /** Set when the text came from a voice note: shown on approval cards so a mis-heard word is caught. */
    spoken?: boolean
    /** The voice note's detected language, so a voice reply is spoken in it. */
    language?: string
    log: Logger
    job: JobInfo
  }) {
    const { user, log, job } = opts
    const history = await repo.recentConversation(user.id, {
      limit: deps.historyLimit ?? 12,
      since: new Date(now().getTime() - (deps.historyWindowMs ?? 6 * 60 * 60_000)),
      excludeId: opts.triggerMessageId,
    })
    const runId = await repo.createRun({ userId: user.id, triggerMessageId: opts.triggerMessageId, model: deps.model })
    const actions: ActionLog = {
      create: (a) => repo.createAction({ ...a, userId: user.id, runId }),
      update: (id, patch) => repo.updateAction(id, patch),
    }

    // Read receipt / typing indicator while the agent works. Best-effort.
    const stopTyping = opts.typingFor ? channelFor(user.channel).startTyping(opts.typingFor) : () => {}
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
        channel: user.channel,
        services: servicesFor(user),
        history: history.map((h) => ({ role: h.direction === 'inbound' ? 'user' : 'assistant', text: h.body })),
        message: { text: opts.text, ...(opts.forwarded ? { forwarded: true } : {}) },
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
        connectionRequests: result.connectionRequests,
        durationMs: Date.now() - startedAt,
        ...result.usage,
      },
      'agent run finished',
    )
    try {
      await replyInMode(user, result.reply, { spoken: opts.spoken ?? false, ...(opts.language ? { language: opts.language } : {}), log })
      if (result.connectionRequests.length) await sendConnectLink(user, result.connectionRequests, opts.triggerMessageId)
      const pending = result.toolCalls.filter((t) => t.outcome === 'awaiting_approval' && t.actionId)
      await approvals.sendCards(
        user,
        pending.map((t) => ({ actionId: t.actionId!, tool: t.name, input: t.input, card: t.card })),
        log,
        opts.spoken ? { spokenText: opts.text } : {},
      )
    } catch (err) {
      await repo.finishRun(runId, { ...storedUsage(result.usage), status: 'failed', error: 'reply send failed' })
      throw err
    }
    await repo.finishRun(runId, { ...storedUsage(result.usage), status: result.status })
  }

  async function handleMessage(m: InboundMessage, job: JobInfo) {
    // platformMessageId, not id: Telegram ids embed the chat id, which is the user's Telegram id.
    const log = logger.child({ channel: m.channel, msgId: m.platformMessageId, type: m.type })
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

    // Approval buttons. Only a button payload counts; typed text never approves anything.
    const button = m.reply ? parseApprovalButton(m.reply.id) : null
    if (button) {
      const runId = await repo.createRun({ userId: user.id, triggerMessageId: stored.id, model: 'approval' })
      await approvals.decide(user, m, button, log)
      await repo.finishRun(runId, { status: 'succeeded', inputTokens: 0, outputTokens: 0 })
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
    } else if (m.type === 'audio' && m.media && deps.speech) {
      const heard = await transcribe(user, m, stored.id, log, job)
      if (!heard) return
      await runAndReply({
        user,
        triggerMessageId: stored.id,
        text: heard.text,
        forwarded: m.forwarded ?? false,
        typingFor: m,
        spoken: true,
        ...(heard.language ? { language: heard.language } : {}),
        log,
        job,
      })
      return
    } else if (m.type !== 'text') {
      text = undefined
    }
    if (!text) {
      log.info('unsupported message type')
      await reply(user, UNSUPPORTED_REPLIES[m.type] ?? DEFAULT_UNSUPPORTED)
      return
    }

    await runAndReply({ user, triggerMessageId: stored.id, text, forwarded: m.forwarded ?? false, typingFor: m, log, job })
  }

  /**
   * Voice note → text. Returns the transcript, or null after telling the user why not.
   * The transcript is stored as the message body (it is content: never logged).
   */
  async function transcribe(user: User, m: InboundMessage, messageId: string, log: Logger, job: JobInfo): Promise<Transcript | null> {
    if ((m.media?.durationSec ?? 0) > MAX_VOICE_SECONDS) {
      await reply(user, VOICE_REPLIES.tooLong)
      return null
    }
    const channel = channelFor(user.channel)
    const stopTyping = channel.startTyping(m)
    try {
      const audio = await channel.downloadMedia(m, { maxBytes: MAX_VOICE_BYTES })
      const t = await deps.speech!.transcribe(audio)
      log.info({ durationSec: m.media?.durationSec, language: t.language, chars: t.text.length }, 'voice note transcribed')
      if (!t.text) {
        await reply(user, VOICE_REPLIES.unclear)
        return null
      }
      await repo.setMessageBody(messageId, t.text)
      return t
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        await reply(user, VOICE_REPLIES.tooLong)
        return null
      }
      const transient = (err as { transient?: boolean }).transient === true
      log.warn({ err: err instanceof Error ? err.message : String(err), transient }, 'voice note transcription failed')
      if (transient && !job.finalAttempt) throw err
      await reply(user, VOICE_REPLIES.failed)
      return null
    } finally {
      stopTyping()
    }
  }

  /**
   * PRD F3: reply in the user's mode. "match" answers a voice note with a voice note; "text"
   * and "voice" are fixed. The voice note speaks a link-free version of the reply; when that
   * left something out (links, or it was cut to ~60 s), the full text follows. If speech
   * fails, the text goes out instead, so a reply is never lost.
   */
  async function replyInMode(user: User, markdown: string, opts: { spoken: boolean; language?: string; log: Logger }) {
    const mode = (user.replyMode ?? 'match') as ReplyMode
    const wantVoice = deps.tts && (mode === 'voice' || (mode === 'match' && opts.spoken))
    const speech = wantVoice ? speakable(markdown) : null
    if (!deps.tts || !speech?.text) return reply(user, markdown)
    try {
      const audio = await deps.tts.synthesize(speech.text, opts.language ? { language: opts.language } : {})
      const ids = await channelFor(user.channel).sendVoice(user.externalId, audio)
      const alsoText = speech.hadLinks || speech.truncated
      const sentAt = new Date()
      // History keeps the reply text once: on the voice note, or on the text that follows it.
      for (const id of ids) {
        await repo.insertOutboundMessage({ userId: user.id, channel: user.channel, externalMessageId: id, body: alsoText ? null : markdown, sentAt, type: 'audio' })
      }
      opts.log.info({ language: opts.language, chars: speech.text.length, truncated: speech.truncated, alsoText }, 'voice reply sent')
      if (alsoText) await reply(user, markdown)
    } catch (err) {
      opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'voice reply failed, sending text')
      await reply(user, markdown)
    }
  }

  /** The user finished (or abandoned) connecting an account: confirm, then finish what they asked. */
  async function handleConnection(e: ConnectionEvent, job: JobInfo) {
    const user = await repo.getUserById(e.userId)
    if (!user) return
    const log = logger.child({ channel: user.channel, connection: e.outcome })
    if (e.outcome === 'denied') {
      await reply(user, "No problem, I haven't connected anything. You can ask again whenever you like.")
      return
    }
    if (e.outcome === 'failed') {
      await reply(user, 'Something went wrong while connecting your Google account. Please ask me again to get a new link.')
      return
    }
    const lines = [`✅ Connected ${products(e.granted.length ? e.granted : e.needed)}${e.account ? ` (${e.account})` : ''}.`]
    // Only what this request needed matters here; optional permissions left unticked are fine.
    if (e.missing.length) lines.push(`You didn't allow me to ${labels(e.missing)}, so I can't do that part.`)
    await reply(user, lines.join('\n'))

    const trigger = e.triggerMessageId ? await repo.getMessageById(e.triggerMessageId) : null
    if (!trigger?.body || e.missing.length) return
    log.info('resuming request after connection')
    await runAndReply({ user, triggerMessageId: trigger.id, text: trigger.body, log, job })
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

  return async function handle(event: QueueEvent, job: JobInfo = { finalAttempt: true }) {
    if (event.kind === 'status') return handleStatus(event.status)
    if (event.kind === 'connection') return perUser.run(`user:${event.userId}`, () => handleConnection(event, job))
    // One conversation at a time per user, so quick follow-ups see earlier replies.
    const { channel, from } = event.message
    return perUser.run(`${channel}:${from}`, () => handleMessage(event.message, job))
  }
}
