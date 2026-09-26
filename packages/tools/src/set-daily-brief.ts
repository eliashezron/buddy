import { defineTool } from '@wa/core'
import { z } from 'zod'

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** low_write: the user's daily brief settings (on/off, time, timezone). */
export const setDailyBrief = defineTool({
  name: 'set_daily_brief',
  description:
    "Change the user's daily brief (a short morning summary of their calendar and email): turn it on or off, " +
    'set the time, or set their timezone. Use when the user asks, e.g. "stop the daily brief", "send my brief at ' +
    '6:30", "I\'m in Nairobi now", "start sending me a morning brief". Give only the fields that change. Only when ' +
    'the user asked in their own message.',
  risk: 'low_write',
  input: z.object({
    enabled: z.boolean().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Local time, 24-hour HH:MM, e.g. 06:30'),
    timezone: z.string().max(64).optional().describe('IANA timezone, e.g. Africa/Nairobi, Europe/London'),
  }),
  preview: ({ enabled, time, timezone }) =>
    [enabled === false ? 'Turn off the daily brief' : enabled ? 'Turn on the daily brief' : '', time ? `brief at ${time}` : '', timezone ? `timezone ${timezone}` : '']
      .filter(Boolean)
      .join(', '),
  async execute({ enabled, time, timezone }, ctx) {
    if (enabled === undefined && !time && !timezone) return { ok: false as const, error: 'Nothing to change.' }
    if (timezone && !validZone(timezone)) return { ok: false as const, error: `"${timezone}" is not a timezone name (e.g. Africa/Nairobi).` }
    await ctx.services.preferences.setDailyBrief({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(time ? { time } : {}),
      ...(timezone ? { timezone } : {}),
    })
    return {
      ok: true as const,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(time ? { time } : {}),
      ...(timezone ? { timezone } : {}),
      note: 'Takes effect from the next brief. On WhatsApp a brief is sent only while the user has written in the last 24 hours.',
    }
  },
})
