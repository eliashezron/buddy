import {
  ChannelSendError,
  NeedsConnectionError,
  type AnyTool,
  type ApprovalDecision,
  type Capability,
  type Channel,
  type InboundMessage,
  type Logger,
  type ToolServices,
} from '@wa/core'
import type { Repo, User } from '@wa/db'

/**
 * The approval engine's worker half (CLAUDE.md: `outbound` and `money` actions require
 * explicit user approval; approvals expire after 15 minutes).
 *
 * The agent loop only ever creates `awaiting_approval` rows. This module shows each one
 * to the user as a card, and executes it only when that same user presses its Approve
 * button before it expires. It executes the input stored in the row, never anything
 * the model says afterwards. Typed text can't approve: only a button press, parsed by
 * `parseApprovalButton`, reaches `decide`.
 */

export type ApprovalRepo = Pick<Repo, 'decideApproval' | 'updateAction' | 'insertOutboundMessage'>

export interface ApprovalDeps {
  repo: ApprovalRepo
  toolsByName: Map<string, AnyTool>
  channelFor(user: User): Channel
  /** Sends a system message to the user (stored as outbound history). */
  reply(user: User, markdown: string): Promise<void>
  servicesFor(user: User): ToolServices
  /** Sends a one-time connect link, if connectors are configured. */
  sendConnectLink(user: User, capabilities: Capability[]): Promise<void>
  logger: Logger
  now(): Date
}

export const APPROVAL_REPLIES = {
  cancelled: 'Cancelled. Nothing was sent.',
  expired: 'That request expired after 15 minutes, so nothing was sent. Ask me again if you still want it.',
  notFound: 'That button no longer works. Tell me what you need and I will set it up again.',
  alreadySent: 'That was already done.',
  alreadyCancelled: 'That was already cancelled.',
  noLongerPending: 'That request is no longer waiting for approval.',
  /** The tool reported failure: nothing went out. */
  failed: "Sorry, that didn't go through, and nothing was sent. Please try again in a moment.",
  /** It threw (timeout, network): it may or may not have gone out. Never retried automatically. */
  uncertain: 'Sorry, something went wrong while sending. It may not have gone out; please check before asking me again.',
  needsAccess: "I don't have permission for that any more, so nothing was sent. I've sent you a link to reconnect; then ask me again.",
} as const

const title = (tool: AnyTool | undefined, input: unknown, fallback: string) => tool?.title?.(input) ?? fallback

export function createApprovals(deps: ApprovalDeps) {
  const { repo, logger } = deps

  /** After the agent's reply: one card per action awaiting approval. */
  async function sendCards(user: User, pending: { actionId: string; tool: string; input: unknown }[], log: Logger) {
    for (const p of pending) {
      const tool = deps.toolsByName.get(p.tool)
      if (!tool) continue
      const card = { actionId: p.actionId, preview: tool.preview(p.input), title: title(tool, p.input, tool.name), approveLabel: 'Send' }
      try {
        const ids = await deps.channelFor(user).sendApproval(user.externalId, card)
        const sentAt = deps.now()
        for (const id of ids) {
          await repo.insertOutboundMessage({ userId: user.id, channel: user.channel, externalMessageId: id, body: card.preview, sentAt })
        }
      } catch (err) {
        // The user never saw it, so it can't be approved: close it rather than leave it pending.
        await repo.updateAction(p.actionId, { status: 'cancelled', error: 'approval card not delivered' })
        if (err instanceof ChannelSendError && err.permanent) {
          log.warn({ actionId: p.actionId, err }, 'approval card dropped')
          continue
        }
        throw err
      }
      log.info({ actionId: p.actionId, tool: p.tool }, 'approval requested')
    }
  }

  /** A press of an Approve or Cancel button, already parsed from the button payload. */
  async function decide(user: User, pressed: InboundMessage, button: { decision: ApprovalDecision; actionId: string }, log: Logger) {
    const outcome = await repo.decideApproval({ actionId: button.actionId, userId: user.id, decision: button.decision, now: deps.now() })
    const channel = deps.channelFor(user)
    log.info({ actionId: button.actionId, decision: button.decision, outcome: outcome.kind }, 'approval button')

    switch (outcome.kind) {
      case 'not_found':
        await channel.closeApproval(pressed, 'No longer available')
        return deps.reply(user, APPROVAL_REPLIES.notFound)
      case 'expired':
        await channel.closeApproval(pressed, 'Expired')
        return deps.reply(user, APPROVAL_REPLIES.expired)
      case 'already_decided': {
        await channel.closeApproval(pressed, 'Already handled')
        const s = outcome.action.status
        return deps.reply(user, s === 'succeeded' ? APPROVAL_REPLIES.alreadySent : s === 'cancelled' ? APPROVAL_REPLIES.alreadyCancelled : APPROVAL_REPLIES.noLongerPending)
      }
      case 'cancelled':
        await channel.closeApproval(pressed, 'Cancelled')
        return deps.reply(user, APPROVAL_REPLIES.cancelled)
      case 'approved':
        await channel.closeApproval(pressed, 'Sending…')
        return execute(user, outcome.action, log)
    }
  }

  async function execute(user: User, action: { id: string; tool: string; runId: string | null; input: unknown }, log: Logger) {
    const tool = deps.toolsByName.get(action.tool)
    // Defence in depth: the stored input was validated when the model proposed it; check again.
    const parsed = tool?.input.safeParse(action.input)
    if (!tool || !parsed?.success) {
      await repo.updateAction(action.id, { status: 'failed', error: tool ? 'stored input no longer valid' : 'unknown tool' })
      log.error({ actionId: action.id, tool: action.tool }, 'approved action cannot run')
      return deps.reply(user, APPROVAL_REPLIES.failed)
    }
    try {
      const output = await tool.execute(parsed.data, {
        userId: user.id,
        runId: action.runId ?? 'approval',
        actionId: action.id,
        timezone: user.timezone,
        now: deps.now(),
        logger: log.child({ tool: tool.name, actionId: action.id }),
        services: deps.servicesFor(user),
      })
      const failed = typeof output === 'object' && output !== null && 'ok' in output && output.ok === false
      await repo.updateAction(action.id, { status: failed ? 'failed' : 'succeeded', result: output })
      if (failed) return deps.reply(user, APPROVAL_REPLIES.failed)
      return deps.reply(user, `✅ Done: ${title(tool, parsed.data, 'sent')}.`)
    } catch (err) {
      if (err instanceof NeedsConnectionError) {
        await repo.updateAction(action.id, { status: 'failed', error: `needs_connection:${err.problem}` })
        await deps.reply(user, APPROVAL_REPLIES.needsAccess)
        return deps.sendConnectLink(user, err.capabilities)
      }
      // Not retried: the row has left `awaiting_approval`, so a retry could only double-send.
      await repo.updateAction(action.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
      logger.warn({ err, actionId: action.id, tool: tool.name }, 'approved action failed')
      return deps.reply(user, APPROVAL_REPLIES.uncertain)
    }
  }

  return { sendCards, decide }
}
