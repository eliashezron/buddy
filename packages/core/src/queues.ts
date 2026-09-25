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

/** Everything that goes on the inbound queue. */
export type QueueEvent = ChannelEvent | ConnectionEvent
