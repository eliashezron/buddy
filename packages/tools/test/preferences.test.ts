import { describe, expect, it } from 'vitest'
import { createLogger, noServices, type ToolContext } from '@wa/core'
import { setDailyBrief, setReplyMode } from '../src/index.js'

function ctx() {
  const calls: unknown[] = []
  const services = {
    ...noServices(),
    preferences: {
      setReplyMode: async (mode: string) => void calls.push({ replyMode: mode }),
      setDailyBrief: async (patch: unknown) => void calls.push({ brief: patch }),
    },
  }
  const c: ToolContext = { userId: 'u', runId: 'r', actionId: 'a', timezone: 'Africa/Kampala', now: new Date(), logger: createLogger({ name: 't', level: 'silent' }), services }
  return { c, calls }
}

describe('preference tools', () => {
  it('set_daily_brief changes only the given fields and checks the timezone and time', async () => {
    const { c, calls } = ctx()
    expect(await setDailyBrief.execute({ time: '06:30', timezone: 'Africa/Nairobi' }, c)).toMatchObject({ ok: true, time: '06:30', timezone: 'Africa/Nairobi' })
    expect(await setDailyBrief.execute({ enabled: false }, c)).toMatchObject({ ok: true, enabled: false })
    expect(calls).toEqual([{ brief: { time: '06:30', timezone: 'Africa/Nairobi' } }, { brief: { enabled: false } }])
    expect(await setDailyBrief.execute({ timezone: 'Kampala' }, c)).toMatchObject({ ok: false })
    expect(await setDailyBrief.execute({}, c)).toMatchObject({ ok: false })
    expect(setDailyBrief.input.safeParse({ time: '25:00' }).success).toBe(false)
    expect(setDailyBrief.input.safeParse({ time: '6:30' }).success).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('set_reply_mode stores the mode', async () => {
    const { c, calls } = ctx()
    await setReplyMode.execute({ mode: 'voice' }, c)
    expect(calls).toEqual([{ replyMode: 'voice' }])
  })
})
