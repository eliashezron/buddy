import { defineTool, REPLY_MODES } from '@wa/core'
import { z } from 'zod'

const LABEL = { match: 'the way you write (voice notes get voice replies)', text: 'text only', voice: 'voice notes' } as const

/** low_write: how the assistant replies to this user (PRD F3's setting). */
export const setReplyMode = defineTool({
  name: 'set_reply_mode',
  description:
    'Change how you reply to the user from now on: "text" (always text), "voice" (always a voice note), or ' +
    '"match" (voice note → voice reply, text → text; the default). Use when the user asks, e.g. "reply in text ' +
    'from now on", "send me voice notes", "answer the way I write". Only when the user asked in their own message.',
  risk: 'low_write',
  input: z.object({ mode: z.enum(REPLY_MODES) }),
  preview: ({ mode }) => `Reply in ${LABEL[mode]} from now on`,
  async execute({ mode }, ctx) {
    await ctx.services.preferences.setReplyMode(mode)
    return { ok: true as const, mode, meaning: LABEL[mode], note: 'Takes effect from the next reply.' }
  },
})
