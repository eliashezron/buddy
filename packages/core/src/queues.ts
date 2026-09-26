import { createHash } from 'node:crypto'
import type { ChannelEvent } from './channel.js'
import type { Capability } from './connections.js'


/** BullMQ queue names shared by the api (producer) and worker (consumers). */
export const QUEUES = {
  inbound: 'inbound',
  maintenance: 'maintenance',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/**
 * Raised by the api's OAuth callback: the user finished (or abandoned) connecting an
 * account. The worker confirms in chat and re-runs the request that needed it.
 */
export interface ConnectionEvent {
  kind: 'connection'
  /** Dedup key: the hash of the one-time link token. */
  id: string
  outcome: 'connected' | 'denied' | 'failed'
  userId: string
  triggerMessageId: string | null
  /** Everything offered on Google's consent screen. */
  requested: Capability[]
  /** What the triggering request needs. */
  needed: Capability[]
  /** What the user allowed (all their Google grants, including earlier ones). */
  granted: Capability[]
  /** Needed but not allowed: the request can't be re-run. */
  missing: Capability[]
  account: string | null
}

/** The scheduler found this user's daily brief due (worker: maintenance tick → inbound queue). */
export interface BriefEvent {
  kind: 'brief'
  userId: string
  /** Local date the brief is for (YYYY-MM-DD); with userId, the dedup key. */
  date: string
  /** For the per-user lock, which is keyed like messages. */
  channel: string
  from: string
}

/** Everything that goes on the inbound queue. */
export type QueueEvent = ChannelEvent | ConnectionEvent | BriefEvent

/**
 * Queue job id: redelivered events map to the same id, so they are processed once.
 * A brief's id is its user and local date, so a day's brief is queued at most once.
 */
export function jobIdFor(event: QueueEvent): string {
  const key =
    event.kind === 'message'
      ? `m:${event.message.channel}:${event.message.id}`
      : event.kind === 'status'
        ? `s:${event.status.channel}:${event.status.id}:${event.status.status}`
        : event.kind === 'brief'
          ? `b:${event.userId}:${event.date}`
          : `c:${event.id}`
  return `${event.kind}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
}
