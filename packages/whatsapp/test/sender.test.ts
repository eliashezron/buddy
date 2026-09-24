import { describe, expect, it } from 'vitest'
import { FakeWhatsAppClient } from '../src/client.js'
import { createSender, OutsideServiceWindowError } from '../src/sender.js'

const now = new Date('2026-09-24T12:00:00Z')

describe('sender', () => {
  it('sends inside the 24 h window', async () => {
    const client = new FakeWhatsAppClient()
    const sender = createSender({ client, getLastInboundAt: async () => new Date(now.getTime() - 60_000), now: () => now })
    expect(await sender.sendText('256770000001', 'hi')).toEqual(['wamid.FAKE_1'])
    expect(client.sent).toEqual([{ method: 'sendText', to: '256770000001', body: 'hi' }])
  })

  it('refuses outside the window and when the user never wrote', async () => {
    const client = new FakeWhatsAppClient()
    const stale = createSender({
      client,
      getLastInboundAt: async () => new Date(now.getTime() - 24 * 60 * 60_000),
      now: () => now,
    })
    await expect(stale.sendText('x', 'hi')).rejects.toBeInstanceOf(OutsideServiceWindowError)
    const never = createSender({ client, getLastInboundAt: async () => null, now: () => now })
    await expect(never.sendText('x', 'hi')).rejects.toBeInstanceOf(OutsideServiceWindowError)
    expect(client.calls).toEqual([])
  })

  it('splits long replies and quotes only the first chunk', async () => {
    const client = new FakeWhatsAppClient()
    const sender = createSender({ client, getLastInboundAt: async () => now, now: () => now })
    const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`
    const ids = await sender.sendText('x', long, { replyToId: 'wamid.IN' })
    expect(ids).toHaveLength(2)
    expect(client.sent[0]?.replyToId).toBe('wamid.IN')
    expect(client.sent[1]?.replyToId).toBeUndefined()
  })
})
