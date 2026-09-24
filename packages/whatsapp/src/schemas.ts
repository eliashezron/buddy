import { z } from 'zod'

/**
 * Cloud API webhook payload schemas (docs/whatsapp-notes.md §4.3).
 *
 * Shapes are *expected*, not confirmed against Meta's reference (see the
 * verification note in whatsapp-notes.md). Objects are loose so an extra field
 * from Meta never drops a message; only the fields we rely on are required.
 */

const mediaSchema = z.looseObject({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
})

export const inboundMessageSchema = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  context: z
    .looseObject({
      from: z.string().optional(),
      id: z.string().optional(),
      forwarded: z.boolean().optional(),
      frequently_forwarded: z.boolean().optional(),
    })
    .optional(),
  text: z.looseObject({ body: z.string() }).optional(),
  audio: mediaSchema.optional(),
  image: mediaSchema.optional(),
  document: mediaSchema.optional(),
  video: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z
        .looseObject({ id: z.string(), title: z.string(), description: z.string().optional() })
        .optional(),
    })
    .optional(),
  button: z.looseObject({ payload: z.string().optional(), text: z.string().optional() }).optional(),
})

export const statusSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string(),
  errors: z
    .array(z.looseObject({ code: z.number(), title: z.string().optional(), message: z.string().optional() }))
    .optional(),
})

const changeValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: z.looseObject({ display_phone_number: z.string(), phone_number_id: z.string() }),
  contacts: z
    .array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() }))
    .optional(),
  messages: z.array(inboundMessageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
})

export const webhookPayloadSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(
        z.looseObject({
          field: z.string(),
          value: z.unknown(),
        }),
      ),
    }),
  ),
})

export { changeValueSchema }
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>
export type RawInboundMessage = z.infer<typeof inboundMessageSchema>
export type RawStatus = z.infer<typeof statusSchema>
