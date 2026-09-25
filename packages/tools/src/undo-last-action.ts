import { defineTool } from '@wa/core'
import { z } from 'zod'

export const undoLastAction = defineTool({
  name: 'undo_last_action',
  description:
    'Undo the most recent change you made for the user (an event you added or removed, a draft you saved), if it ' +
    'was within the last 10 minutes. Use this, not delete_calendar_event or another tool, whenever the user says ' +
    '"undo", "cancel that", "remove what you just added" or "put it back". No lookup needed first.',
  risk: 'low_write',
  input: z.object({}),
  preview: () => 'Undo the last change',
  async execute(_input, ctx) {
    const outcome = await ctx.services.undo.undoLatest()
    return outcome.undone ? { ok: true as const, undone: outcome.description } : { ok: false as const, error: outcome.reason }
  },
})
