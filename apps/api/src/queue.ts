import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { jobIdFor, QUEUES, type QueueEvent } from '@wa/core'

export { jobIdFor }

const DEDUP_WINDOW_MS = 3 * 24 * 60 * 60_000

/**
 * Delivery is at-least-once. The job id is derived from the channel message id, and
 * completed jobs are kept for the dedup window, so a redelivered webhook adds
 * nothing. The worker's unique index on wa_message_id is the second line.
 */

export function createInboundQueue(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: 3, enableOfflineQueue: false })
  const queue = new Queue<QueueEvent>(QUEUES.inbound, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: DEDUP_WINDOW_MS / 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  })

  return {
    async enqueue(events: QueueEvent[]) {
      await queue.addBulk(events.map((data) => ({ name: data.kind, data, opts: { jobId: jobIdFor(data) } })))
    },
    async close() {
      await queue.close()
      connection.disconnect()
    },
  }
}
