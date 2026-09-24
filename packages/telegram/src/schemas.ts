import { z } from 'zod'

/**
 * Telegram Bot API `Update` schemas (https://core.telegram.org/bots/api#update).
 * Loose objects: Telegram adds fields often, and an unknown field must never drop
 * a message. Only the fields we rely on are required.
 */

const userSchema = z.looseObject({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
})

const fileSchema = z.looseObject({
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
})

export const telegramMessageSchema = z.looseObject({
  message_id: z.number(),
  date: z.number(),
  chat: z.looseObject({ id: z.number(), type: z.string() }),
  from: userSchema.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  entities: z.array(z.looseObject({ type: z.string(), offset: z.number(), length: z.number() })).optional(),
  voice: fileSchema.optional(),
  audio: fileSchema.optional(),
  photo: z.array(fileSchema).optional(),
  document: fileSchema.optional(),
  video: fileSchema.optional(),
  sticker: fileSchema.optional(),
  // Bot API 7.0+ uses forward_origin; forward_date is the older marker.
  forward_origin: z.looseObject({ type: z.string() }).optional(),
  forward_date: z.number().optional(),
  reply_to_message: z.looseObject({ message_id: z.number() }).optional(),
})

export const telegramUpdateSchema = z.looseObject({
  update_id: z.number(),
  message: z.unknown().optional(),
})

export type TelegramMessage = z.infer<typeof telegramMessageSchema>
