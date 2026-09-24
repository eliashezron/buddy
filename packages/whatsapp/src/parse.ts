import type { ChannelEvent, InboundMessage, StatusUpdate } from '@wa/core'
import {
  changeValueSchema,
  webhookPayloadSchema,
  type RawInboundMessage,
  type RawStatus,
} from './schemas.js'

export interface ParseResult {
  events: ChannelEvent[]
  /** Changes we saw but don't handle (other fields, malformed values). Counted, never dropped silently. */
  skipped: { field: string; reason: string }[]
}

export class InvalidPayloadError extends Error {
  override name = 'InvalidPayloadError'
}

const MEDIA_TYPES = ['audio', 'image', 'document', 'video', 'sticker'] as const

function toInbound(m: RawInboundMessage, contactName?: string): InboundMessage {
  const out: InboundMessage = {
    channel: 'whatsapp',
    id: m.id,
    from: m.from,
    timestamp: Number(m.timestamp),
    type: m.type,
    platformMessageId: m.id,
  }
  if (contactName) out.contactName = contactName
  if (m.context?.id) out.replyToId = m.context.id
  if (m.context?.forwarded || m.context?.frequently_forwarded) out.forwarded = true
  if (m.text) out.text = m.text.body

  for (const kind of MEDIA_TYPES) {
    const media = m[kind]
    if (m.type === kind && media) {
      out.media = { kind, id: media.id }
      if (media.mime_type) out.media.mimeType = media.mime_type
      if (media.caption) out.media.caption = media.caption
      if (media.voice !== undefined) out.media.voice = media.voice
    }
  }

  const reply = m.interactive?.button_reply ?? m.interactive?.list_reply
  if (reply) out.reply = { id: reply.id, title: reply.title }
  else if (m.button?.payload) out.reply = { id: m.button.payload, title: m.button.text ?? '' }

  return out
}

function toStatus(s: RawStatus): StatusUpdate {
  return {
    channel: 'whatsapp',
    id: s.id,
    status: s.status,
    timestamp: Number(s.timestamp),
    recipientId: s.recipient_id,
    errorCodes: (s.errors ?? []).map((e) => e.code),
  }
}

/**
 * Parses a webhook body that has *already* passed signature verification.
 * Iterates every entry, change, message and status: Meta batches under load.
 */
export function parseWebhook(json: unknown): ParseResult {
  const envelope = webhookPayloadSchema.safeParse(json)
  if (!envelope.success) throw new InvalidPayloadError('not a whatsapp_business_account webhook')

  const events: ChannelEvent[] = []
  const skipped: ParseResult['skipped'] = []

  for (const entry of envelope.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        skipped.push({ field: change.field, reason: 'unhandled field' })
        continue
      }
      const value = changeValueSchema.safeParse(change.value)
      if (!value.success) {
        skipped.push({ field: change.field, reason: 'malformed value' })
        continue
      }
      const { contacts = [], messages = [], statuses = [] } = value.data
      const names = new Map(contacts.map((c) => [c.wa_id, c.profile?.name]))

      for (const m of messages) {
        events.push({ kind: 'message', message: toInbound(m, names.get(m.from)) })
      }
      for (const s of statuses) {
        events.push({ kind: 'status', status: toStatus(s) })
      }
    }
  }
  return { events, skipped }
}
