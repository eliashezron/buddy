import { defineTool } from '@wa/core'
import { z } from 'zod'

export const undoLastAction = defineTool({
  name: 'undo_last_action',
  description:
    'Undo the most recent change you made for the user (e.g. an event you added), if it was within the last ' +
    '10 minutes. Use when the user says "undo", "cancel that", "remove what you just added".',
  risk: 'low_write',
  input: z.object({}),
  preview: () => 'Undo the last change',
  async execute(_input, ctx) {
    const outcome = await ctx.services.undo.undoLatest()
    return outcome.undone ? { ok: true as const, undone: outcome.description } : { ok: false as const, error: outcome.reason }
  },
})
