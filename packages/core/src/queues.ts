/** BullMQ queue names shared by the api (producer) and worker (consumers). */
export const QUEUES = {
  inbound: 'inbound',
  maintenance: 'maintenance',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]
