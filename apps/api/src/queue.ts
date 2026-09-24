import { createHash } from 'node:crypto'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { QUEUES, type ChannelEvent } from '@wa/core'

const DEDUP_WINDOW_MS = 3 * 24 * 60 * 60_000

/**
 * Delivery is at-least-once. The job id is derived from the channel message id, and
 * completed jobs are kept for the dedup window, so a redelivered webhook adds
 * nothing. The worker's unique index on wa_message_id is the second line.
 */
export function jobIdFor(event: ChannelEvent): string {
  const key =
    event.kind === 'message'
      ? `m:${event.message.channel}:${event.message.id}`
      : `s:${event.status.channel}:${event.status.id}:${event.status.status}`
  return `${event.kind}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
}

export function createInboundQueue(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: 3, enableOfflineQueue: false })
  const queue = new Queue<ChannelEvent>(QUEUES.inbound, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: DEDUP_WINDOW_MS / 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  })

  return {
    async enqueue(events: ChannelEvent[]) {
      await queue.addBulk(events.map((data) => ({ name: data.kind, data, opts: { jobId: jobIdFor(data) } })))
    },
    async close() {
      await queue.close()
      connection.disconnect()
    },
  }
}
