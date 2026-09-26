import type { BriefEvent } from '@wa/core'

export { briefPrompt } from '@wa/agent'

/**
 * Daily brief (PRD goal 1): a short morning summary of the user's calendar and email.
 *
 * Who gets one:
 * - Telegram: on by default (users.brief_enabled null or true); "stop the daily brief" turns it off.
 * - WhatsApp: only users who asked for it (brief_enabled true), and only while the 24 h
 *   customer service window is open, because free-form messages outside it need an approved
 *   template. A day outside the window is skipped, not queued.
 * - Only users with Google connected: without it there is nothing to brief.
 *
 * A brief is system-initiated, so it runs with read-only tools: nothing in an email or event
 * can make it act. At most one per user per local day (claimed before sending).
 */

/** Between two scheduler ticks, so a user is never skipped. */
export const BRIEF_TICK_MS = 5 * 60_000
/** A WhatsApp brief needs this much of the 24 h window left, so it isn't cut off mid-send. */
const WINDOW_MARGIN_MS = 30 * 60_000
const WINDOW_MS = 24 * 60 * 60_000

export interface BriefUser {
  channel: string
  timezone: string
  briefEnabled: boolean | null
  briefTime: string
  lastBriefOn: string | null
  lastInboundAt: Date | null
}

/** The user's local date (YYYY-MM-DD) and time (HH:MM) at `now`. */
export function localClock(now: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

/** Is `user`'s brief due at `now`? Returns the local date it is for, or null. */
export function briefDue(user: BriefUser, now: Date): string | null {
  const enabled = user.briefEnabled ?? user.channel === 'telegram'
  if (!enabled) return null
  let clock
  try {
    clock = localClock(now, user.timezone)
  } catch {
    return null // unknown timezone: never guess
  }
  if (user.lastBriefOn === clock.date || clock.time < user.briefTime) return null
  if (user.channel === 'whatsapp') {
    const last = user.lastInboundAt?.getTime() ?? 0
    if (now.getTime() - last > WINDOW_MS - WINDOW_MARGIN_MS) return null
  }
  return clock.date
}

/** Added to briefs the user didn't ask for (Telegram default), so opting out is easy to find. */
export function briefFooter(user: { briefEnabled: boolean | null; briefTime: string }): string {
  return user.briefEnabled === true
    ? ''
    : `\n\n_Daily brief at ${user.briefTime}. Say "stop the daily brief" to turn it off, or "brief at 6:30" to move it._`
}

/**
 * One scheduler tick: queue a brief for every user who is due. Queue job ids are the user
 * and local date (jobIdFor), so repeated ticks within the day add nothing.
 */
export async function enqueueDueBriefs(deps: {
  candidates: () => Promise<(BriefUser & { id: string; externalId: string })[]>
  enqueue: (event: BriefEvent) => Promise<void>
  now: Date
}): Promise<number> {
  let queued = 0
  for (const user of await deps.candidates()) {
    const date = briefDue(user, deps.now)
    if (!date) continue
    await deps.enqueue({ kind: 'brief', userId: user.id, date, channel: user.channel, from: user.externalId })
    queued++
  }
  return queued
}
