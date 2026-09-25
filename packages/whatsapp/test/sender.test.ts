import { describe, expect, it } from 'vitest'
import { ChannelSendError, type InboundMessage } from '@wa/core'
import { FakeWhatsAppClient, GraphApiError } from '../src/client.js'
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

  describe('link buttons', () => {
    const link = { text: 'Connect your Google account.', url: 'https://x/start?s=T', label: 'Connect Google' }
    const open = () => new Date(now.getTime() - 60_000)

    it('sends a URL button, and falls back to text + URL when Meta rejects it', async () => {
      const client = new FakeWhatsAppClient()
      const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => open(), now: () => now })
      await ch.sendLink('256770000001', link)
      expect(client.calls).toEqual([{ method: 'sendUrlButton', to: '256770000001', body: 'Connect your Google account.', label: 'Connect Google', url: 'https://x/start?s=T' }])

      client.sendUrlButton = async () => {
        throw new GraphApiError(400, 131009, 'Parameter value is not valid')
      }
      await ch.sendLink('256770000001', link)
      expect(client.calls.at(-1)).toEqual({ method: 'sendText', to: '256770000001', body: 'Connect your Google account.\nhttps://x/start?s=T' })
    })
  })

  describe('approval cards', () => {
    const ACTION = '0b6f6c55-3a1e-4d1f-9c55-2d1c1f5c9e11'
    const card = (preview: string) => ({ actionId: ACTION, preview, title: 'Email to kato@example.com', approveLabel: 'Send' })
    const open = () => new Date(now.getTime() - 60_000)

    it('puts a short preview on the button message itself', async () => {
      const client = new FakeWhatsAppClient()
      const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => open(), now: () => now })
      await ch.sendApproval('256770000001', card('**Send this?**'))
      expect(client.calls).toEqual([
        {
          method: 'sendButtons',
          to: '256770000001',
          body: '*Send this?*',
          buttons: [{ id: `approve:${ACTION}`, title: 'Send' }, { id: `cancel:${ACTION}`, title: 'Cancel' }],
        },
      ])
    })

    it('sends a preview over 1024 chars in full first, then the buttons', async () => {
      const client = new FakeWhatsAppClient()
      const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => open(), now: () => now })
      await ch.sendApproval('256770000001', card('x'.repeat(1500)))
      expect(client.calls.map((c) => c.method)).toEqual(['sendText', 'sendButtons'])
      expect((client.calls[0] as { body: string }).body).toHaveLength(1500)
    })

    it('respects the 24 h window like any other send', async () => {
      const client = new FakeWhatsAppClient()
      const ch = createWhatsAppChannel({ client, getLastInboundAt: async () => null, now: () => now })
      await expect(ch.sendApproval('256770000001', card('hi'))).rejects.toBeInstanceOf(OutsideServiceWindowError)
      expect(client.calls).toEqual([])
    })
  })
})
