import { describe, expect, it } from 'vitest'
import { ChannelSendError, type InboundMessage } from '@wa/core'
import { FakeWhatsAppClient } from '../src/client.js'
import { createWhatsAppChannel, OutsideServiceWindowError } from '../src/sender.js'

const now = new Date('2026-09-24T12:00:00Z')

describe('WhatsApp channel', () => {
  it('sends inside the 24 h window, converting Markdown to WhatsApp formatting', async () => {
    const client = new FakeWhatsAppClient()
    const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => new Date(now.getTime() - 60_000), now: () => now })
    expect(await ch.sendText('256770000001', '**hi** _there_')).toEqual(['wamid.FAKE_1'])
    expect(client.sent).toEqual([{ method: 'sendText', to: '256770000001', body: '*hi* _there_' }])
  })

  it('refuses outside the window and when the user never wrote, as a permanent send error', async () => {
    const client = new FakeWhatsAppClient()
    const stale = createWhatsAppChannel({
      client,
      getLastInboundAt: async () => new Date(now.getTime() - 24 * 60 * 60_000),
      now: () => now,
    })
    const err = await stale.sendText('x', 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OutsideServiceWindowError)
    expect((err as ChannelSendError).permanent).toBe(true)
    const never = createWhatsAppChannel({ client, getLastInboundAt: async () => null, now: () => now })
    await expect(never.sendText('x', 'hi')).rejects.toBeInstanceOf(OutsideServiceWindowError)
    expect(client.calls).toEqual([])
  })

  it('splits long replies', async () => {
    const client = new FakeWhatsAppClient()
    const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => now, now: () => now })
    expect(await ch.sendText('x', `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`)).toHaveLength(2)
  })

  it('marks the message read with a typing indicator', () => {
    const client = new FakeWhatsAppClient()
    const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => now })
    const msg = { channel: 'whatsapp', id: 'wamid.IN', platformMessageId: 'wamid.IN', from: 'x', timestamp: 1, type: 'text' } satisfies InboundMessage
    ch.startTyping(msg)()
    expect(client.calls).toEqual([{ method: 'markRead', messageId: 'wamid.IN', typing: true }])
  })
})
