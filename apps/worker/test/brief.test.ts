import { describe, expect, it } from 'vitest'
import { briefDue, briefFooter, briefPrompt, enqueueDueBriefs, localClock, type BriefUser } from '../src/brief.js'

// 2026-09-27 04:30 UTC = 07:30 in Kampala (UTC+3).
const NOW = new Date('2026-09-27T04:30:00Z')
const tg = (over: Partial<BriefUser> = {}): BriefUser => ({ channel: 'telegram', timezone: 'Africa/Kampala', briefEnabled: null, briefTime: '07:00', lastBriefOn: null, lastInboundAt: null, ...over })

describe('daily brief scheduling', () => {
  it('reads the local date and time in the user\'s timezone', () => {
    expect(localClock(NOW, 'Africa/Kampala')).toEqual({ date: '2026-09-27', time: '07:30' })
    expect(localClock(NOW, 'America/New_York')).toEqual({ date: '2026-09-27', time: '00:30' })
    expect(localClock(new Date('2026-09-26T22:30:00Z'), 'Africa/Kampala')).toEqual({ date: '2026-09-27', time: '01:30' })
  })

  it('Telegram: on by default, due from the brief time, once per local day, and can be turned off', () => {
    expect(briefDue(tg(), NOW)).toBe('2026-09-27')
    expect(briefDue(tg({ briefTime: '08:00' }), NOW)).toBeNull()
    expect(briefDue(tg({ lastBriefOn: '2026-09-27' }), NOW)).toBeNull()
    expect(briefDue(tg({ lastBriefOn: '2026-09-26' }), NOW)).toBe('2026-09-27')
    expect(briefDue(tg({ briefEnabled: false }), NOW)).toBeNull()
    // Only within 3 h of the brief time: no "morning" brief in the evening (e.g. right after a deploy).
    expect(briefDue(tg({ briefTime: '04:31' }), NOW)).toBe('2026-09-27')
    expect(briefDue(tg({ briefTime: '04:30' }), NOW)).toBeNull()
    expect(briefDue(tg(), new Date('2026-09-27T15:00:00Z'))).toBeNull()
    // Someone in New York at 00:30 isn't due yet.
    expect(briefDue(tg({ timezone: 'America/New_York' }), NOW)).toBeNull()
    expect(briefDue(tg({ timezone: 'Not/AZone' }), NOW)).toBeNull()
  })

  it('WhatsApp: only if the user asked for it, and only inside the 24 h window (with a margin)', () => {
    const wa = (over: Partial<BriefUser>) => tg({ channel: 'whatsapp', ...over })
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60_000)
    expect(briefDue(wa({ briefEnabled: null, lastInboundAt: hoursAgo(1) }), NOW)).toBeNull() // not opted in
    expect(briefDue(wa({ briefEnabled: true, lastInboundAt: hoursAgo(1) }), NOW)).toBe('2026-09-27')
    expect(briefDue(wa({ briefEnabled: true, lastInboundAt: hoursAgo(23.8) }), NOW)).toBeNull() // window about to close
    expect(briefDue(wa({ briefEnabled: true, lastInboundAt: hoursAgo(30) }), NOW)).toBeNull()
    expect(briefDue(wa({ briefEnabled: true, lastInboundAt: null }), NOW)).toBeNull()
  })

  it('queues one event per due user, with the local date', async () => {
    const events: unknown[] = []
    const queued = await enqueueDueBriefs({
      candidates: async () => [
        { ...tg(), id: 'u1', externalId: '555' },
        { ...tg({ lastBriefOn: '2026-09-27' }), id: 'u2', externalId: '556' },
      ],
      enqueue: async (e) => void events.push(e),
      now: NOW,
    })
    expect(queued).toBe(1)
    expect(events).toEqual([{ kind: 'brief', userId: 'u1', date: '2026-09-27', channel: 'telegram', from: '555' }])
  })

  it('asks for a summary with the date resolved, and tells default users how to opt out', () => {
    expect(briefPrompt('2026-09-27')).toContain('today, 2026-09-27')
    expect(briefPrompt('2026-09-27')).toContain('do not take any actions')
    expect(briefFooter({ briefEnabled: null, briefTime: '07:00' })).toContain('stop the daily brief')
    expect(briefFooter({ briefEnabled: true, briefTime: '07:00' })).toBe('')
  })
})
