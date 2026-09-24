import { describe, expect, it } from 'vitest'
import { loadFixture, normaliseFixture, resolveFixture } from '../lib/fixture.js'

describe('replay fixtures', () => {
  it('resolves by name or by path, and refuses anything outside fixtures/', () => {
    expect(resolveFixture('book-meeting')).toMatch(/fixtures\/book-meeting\.json$/)
    expect(resolveFixture('fixtures/book-meeting.json', `${import.meta.dirname}/../..`)).toMatch(/book-meeting\.json$/)
    expect(() => resolveFixture('../package.json')).toThrow(/not found/)
    expect(() => resolveFixture('/etc/passwd')).toThrow(/not found/)
  })

  it('strips _fixture and fills placeholders from env', () => {
    const out = normaliseFixture(loadFixture(resolveFixture('voice-note')), {
      env: { WHATSAPP_PHONE_NUMBER_ID: 'PN1', WHATSAPP_WABA_ID: 'WABA1' },
    }) as any
    expect(out._fixture).toBeUndefined()
    expect(out.entry[0].id).toBe('WABA1')
    expect(out.entry[0].changes[0].value.metadata.phone_number_id).toBe('PN1')
    // No REPLAY_MEDIA_ID set: placeholder left as is.
    expect(out.entry[0].changes[0].value.messages[0].audio.id).toBe('MEDIA_ID_PLACEHOLDER')
  })

  it('rebases timestamps and suffixes message ids for live replays', () => {
    const now = new Date('2026-09-24T12:00:00Z')
    const out = normaliseFixture(loadFixture(resolveFixture('book-meeting')), { rebaseTo: now, idSuffix: 'abc' }) as any
    const msg = out.entry[0].changes[0].value.messages[0]
    expect(msg.timestamp).toBe(String(now.getTime() / 1000))
    expect(msg.id).toBe('wamid.TEST_BOOK_MEETING_0001_abc')
  })
})
