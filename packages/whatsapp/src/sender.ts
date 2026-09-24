import type { WhatsAppClient } from './client.js'
import { splitMessage } from './format.js'

export const SERVICE_WINDOW_MS = 24 * 60 * 60_000

export class OutsideServiceWindowError extends Error {
  override name = 'OutsideServiceWindowError'
  constructor(readonly lastInboundAt: Date | null) {
    super('24-hour customer service window is closed; use an approved template or queue the message')
  }
}

export interface Sender {
  /** Sends free-form text, split into WhatsApp-sized chunks. Enforces the 24 h window. */
  sendText(to: string, body: string, opts?: { replyToId?: string }): Promise<string[]>
}

export interface SenderDeps {
  client: WhatsAppClient
  /** Reads `users.last_inbound_at`. Checked on every send, in the sender, not the caller. */
  getLastInboundAt(waId: string): Promise<Date | null>
  now?: () => Date
}

export function createSender({ client, getLastInboundAt, now = () => new Date() }: SenderDeps): Sender {
  return {
    async sendText(to, body, opts = {}) {
      const last = await getLastInboundAt(to)
      if (!last || now().getTime() - last.getTime() >= SERVICE_WINDOW_MS) {
        throw new OutsideServiceWindowError(last)
      }
      const ids: string[] = []
      const chunks = splitMessage(body)
      for (const [i, chunk] of chunks.entries()) {
        // Only the first chunk quotes the user's message; the rest follow in order.
        const sendOpts = i === 0 && opts.replyToId ? { replyToId: opts.replyToId } : {}
        const { messageId } = await client.sendText(to, chunk, sendOpts)
        ids.push(messageId)
      }
      return ids
    },
  }
}
