import { describe, expect, it } from 'vitest'
import { InvalidPayloadError, parseWebhook } from '../src/parse.js'
import { fixture, fixtureNames } from './helpers.js'

describe('parseWebhook', () => {
  it.each(fixtureNames)('parses fixture %s without skipping anything', (name) => {
    const { events, skipped } = parseWebhook(fixture(name))
    expect(events.length).toBeGreaterThan(0)
    expect(skipped).toEqual([])
  })

  it('normalises a text message', () => {
    const [event] = parseWebhook(fixture('book-meeting')).events
    expect(event).toEqual({
      kind: 'message',
      message: {
        channel: 'whatsapp',
        id: 'wamid.TEST_BOOK_MEETING_0001',
        from: '256770000001',
        timestamp: 1790000000,
        type: 'text',
        platformMessageId: 'wamid.TEST_BOOK_MEETING_0001',
        contactName: 'Elias',
        text: 'book coffee with Amina tomorrow 10am',
      },
    })
  })

  it('normalises a voice note, a button reply and a status', () => {
    const voice = parseWebhook(fixture('voice-note')).events[0]
    expect(voice?.kind === 'message' && voice.message.media).toEqual({
      kind: 'audio',
      id: 'MEDIA_ID_PLACEHOLDER',
      mimeType: 'audio/ogg; codecs=opus',
      voice: true,
    })

    const button = parseWebhook(fixture('button-approval')).events[0]
    expect(button?.kind === 'message' && button.message.reply).toEqual({ id: 'approve:ACTION_ID_PLACEHOLDER', title: 'Confirm' })
    expect(button?.kind === 'message' && button.message.replyToId).toBe('wamid.TEST_APPROVAL_PROMPT_0001')

    const status = parseWebhook(fixture('status-update')).events[0]
    expect(status).toEqual({
      kind: 'status',
      status: {
        channel: 'whatsapp',
        id: 'wamid.TEST_OUTBOUND_0001',
        status: 'delivered',
        timestamp: 1790000300,
        recipientId: '256770000001',
        errorCodes: [],
      },
    })
  })

  it('iterates every entry, change, message and status in a batched webhook', () => {
    const a = fixture('book-meeting') as any
    const b = fixture('voice-note') as any
    const s = fixture('status-update') as any
    const batched = {
      object: 'whatsapp_business_account',
      entry: [
        { id: 'W1', changes: [a.entry[0].changes[0], s.entry[0].changes[0]] },
        { id: 'W2', changes: [b.entry[0].changes[0]] },
      ],
    }
    batched.entry[0]!.changes[0].value.messages.push({
      ...a.entry[0].changes[0].value.messages[0],
      id: 'wamid.SECOND',
    })
    const { events } = parseWebhook(batched)
    expect(events.map((e) => (e.kind === 'message' ? e.message.id : e.status.id))).toEqual([
      'wamid.TEST_BOOK_MEETING_0001',
      'wamid.SECOND',
      'wamid.TEST_OUTBOUND_0001',
      'wamid.TEST_VOICE_0001',
    ])
  })

  it('flags forwarded messages', () => {
    const p = fixture('injection-attempt') as any
    p.entry[0].changes[0].value.messages[0].context = { forwarded: true }
    const [event] = parseWebhook(p).events
    expect(event?.kind === 'message' && event.message.forwarded).toBe(true)
  })

  it('skips unhandled fields and malformed changes instead of throwing', () => {
    const { events, skipped } = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'account_update', value: {} }, { field: 'messages', value: { nope: 1 } }] }],
    })
    expect(events).toEqual([])
    expect(skipped).toEqual([
      { field: 'account_update', reason: 'unhandled field' },
      { field: 'messages', reason: 'malformed value' },
    ])
  })

  it('rejects payloads that are not WhatsApp webhooks', () => {
    expect(() => parseWebhook({ object: 'page', entry: [] })).toThrow(InvalidPayloadError)
  })
})
