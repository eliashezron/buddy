import { defineTool } from '@wa/core'
import { z } from 'zod'
import { formatLocal, googleApi } from './google-api.js'

const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  organizer: z.object({ self: z.boolean().optional(), email: z.string().optional(), displayName: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().optional(), self: z.boolean().optional(), resource: z.boolean().optional() })).optional(),
})

const eventUrl = (id: string) => `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`

/**
 * outbound: cancels an event the user organised and that has guests. Google emails every
 * guest a cancellation, so the card shows the event and who will be told, and it runs
 * only after the user presses Cancel event.
 */
export const cancelCalendarEvent = defineTool({
  name: 'cancel_calendar_event',
  description:
    'Cancel a meeting the user organised that has other guests; Google emails each guest a cancellation. Nothing ' +
    'happens when you call this: the user sees the event and the guests who will be told, with buttons, and it ' +
    'is cancelled only if they confirm. Find the event with calendar_list_events first and pass its id. Only when ' +
    'the user asked in their own message. For an event with no guests, use delete_calendar_event instead. It ' +
    "can't cancel meetings someone else organised.",
  risk: 'outbound',
  input: z.object({ eventId: z.string().min(1).max(1024).describe('The id from calendar_list_events') }),
  requires: () => ['calendar.write'],
  approveLabel: 'Cancel meeting',
  title: () => 'Cancel meeting',
  preview: ({ eventId }) => `Cancel event ${eventId} and notify its guests?`,
  async describe({ eventId }, ctx) {
    const event = await googleApi(ctx, ['calendar.write'], eventUrl(eventId), { schema: eventSchema }).catch((err: unknown) => {
      if ([404, 410].includes((err as { status?: number }).status ?? 0)) return null
      throw err
    })
    if (!event || event.status === 'cancelled') return { error: 'event not found (already cancelled?)' }
    const guests = (event.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => a.email ?? 'a guest')
    if (event.organizer?.self === false) {
      const by = event.organizer.displayName ?? event.organizer.email ?? 'someone else'
      return { error: `${by} organised this meeting, so only they can cancel it. The user can decline it in Google Calendar.` }
    }
    if (!guests.length) return { error: 'This event has no other guests: use delete_calendar_event, which needs no approval.' }
    const allDay = !event.start.dateTime
    const start = event.start.dateTime ?? event.start.date ?? ''
    const end = event.end.dateTime ?? event.end.date ?? ''
    const when = allDay ? `${formatLocal(start, ctx.timezone, true)} (all day)` : `${formatLocal(start, ctx.timezone)}–${formatLocal(end, ctx.timezone).split(', ').at(-1)}`
    const title = event.summary ?? '(no title)'
    return {
      preview: ['🗓️ **Cancel this meeting for everyone?**', `**${title}**`, when, `Google will email a cancellation to: ${guests.join(', ')}`].join('\n'),
      title: `Cancel "${title}"`,
    }
  },
  async execute({ eventId }, ctx) {
    await googleApi(ctx, ['calendar.write'], `${eventUrl(eventId)}?sendUpdates=all`, { method: 'DELETE' })
    return { ok: true as const, eventId, cancelled: true, guestsNotified: true }
  },
})
