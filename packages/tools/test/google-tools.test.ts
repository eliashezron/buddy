import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger, NeedsConnectionError, noServices, type ToolContext } from '@wa/core'
import { calendarListEvents, createCalendarEvent, extractEmailText, gmailRead, gmailSearch } from '../src/index.js'

type Handler = (url: URL, init: RequestInit) => { status: number; json?: unknown }
function stubGoogle(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input)
    calls.push({ url, init })
    const r = handler(url, init)
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status })
  })
  return calls
}

function ctx(connected = true): ToolContext {
  return {
    userId: 'u1',
    runId: 'r1',
    actionId: 'a1',
    timezone: 'Africa/Kampala',
    now: new Date('2026-09-24T09:00:00Z'),
    logger: createLogger({ name: 'test', level: 'silent' }),
    services: connected ? { ...noServices(), credentials: { accessToken: async () => 'ya29.token' } } : noServices(),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('calendar_list_events', () => {
  it('queries the primary calendar and returns local times', async () => {
    const calls = stubGoogle(() => ({
      status: 200,
      json: { items: [{ id: 'e1', summary: 'Call with Kato', start: { dateTime: '2026-09-25T12:00:00Z' }, end: { dateTime: '2026-09-25T12:30:00Z' } }] },
    }))
    const out = await calendarListEvents.execute({ from: '2026-09-25T00:00:00+03:00', to: '2026-09-26T00:00:00+03:00' }, ctx())
    expect(out).toMatchObject({ ok: true, count: 1, events: [{ title: 'Call with Kato', when: 'Fri 25 Sept, 15:00–15:30' }] })
    const { url, init } = calls[0]!
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events')
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('timeMin')).toBe('2026-09-24T21:00:00.000Z')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.token')
  })

  it('rejects times without an offset (relative dates must be resolved first)', async () => {
    const out = await calendarListEvents.execute({ from: 'tomorrow', to: '2026-09-26' }, ctx())
    expect(out.ok).toBe(false)
  })

  it('surfaces a missing connection as NeedsConnectionError', async () => {
    await expect(calendarListEvents.execute({ from: '2026-09-25T00:00:00+03:00', to: '2026-09-26T00:00:00+03:00' }, ctx(false))).rejects.toBeInstanceOf(
      NeedsConnectionError,
    )
  })

  it('treats a 401 (revoked at Google) and a 403 insufficient scope as needing a connection', async () => {
    stubGoogle(() => ({ status: 401, json: {} }))
    await expect(calendarListEvents.execute({ from: '2026-09-25T00:00:00+03:00', to: '2026-09-26T00:00:00+03:00' }, ctx())).rejects.toMatchObject({ problem: 'revoked' })
    stubGoogle(() => ({ status: 403, json: { error: { message: 'Request had insufficient authentication scopes.' } } }))
    await expect(calendarListEvents.execute({ from: '2026-09-25T00:00:00+03:00', to: '2026-09-26T00:00:00+03:00' }, ctx())).rejects.toMatchObject({
      problem: 'missing_permission',
    })
  })
})

describe('create_calendar_event', () => {
  it('creates a private event (no guests, no notifications) and can undo it', async () => {
    const calls = stubGoogle((url, init) => (init.method === 'DELETE' ? { status: 204 } : { status: 200, json: { id: 'ev123' } }))
    const out = await createCalendarEvent.execute({ title: 'Focus time', start: '2026-09-25T14:00:00+03:00', durationMins: 120 }, ctx())
    expect(out).toMatchObject({ ok: true, eventId: 'ev123', when: 'Fri 25 Sept, 14:00–16:00', undoableForMinutes: 10 })
    const create = calls[0]!
    expect(create.url.searchParams.get('sendUpdates')).toBe('none')
    const body = JSON.parse(String(create.init.body))
    expect(body.attendees).toBeUndefined()
    expect(body).toMatchObject({ summary: 'Focus time', start: { dateTime: '2026-09-25T11:00:00.000Z', timeZone: 'Africa/Kampala' }, end: { dateTime: '2026-09-25T13:00:00.000Z' } })

    await createCalendarEvent.undo!(out, ctx())
    expect(calls[1]!.init.method).toBe('DELETE')
    expect(calls[1]!.url.pathname).toBe('/calendar/v3/calendars/primary/events/ev123')
  })

  it('treats an already-deleted event as undone', async () => {
    stubGoogle(() => ({ status: 410, json: { error: { message: 'Resource has been deleted' } } }))
    await expect(createCalendarEvent.undo!({ ok: true, eventId: 'gone', title: 'x', when: '', timezone: '', undoableForMinutes: 10 }, ctx())).resolves.toBeUndefined()
  })
})

describe('gmail', () => {
  it('search returns sender, subject, date and snippet', async () => {
    stubGoogle((url) =>
      url.pathname.endsWith('/messages')
        ? { status: 200, json: { messages: [{ id: 'm1' }] } }
        : {
            status: 200,
            json: {
              id: 'm1',
              snippet: 'Please sign and return',
              labelIds: ['UNREAD', 'INBOX'],
              payload: { headers: [{ name: 'From', value: 'Stanbic <a@stanbic.example>' }, { name: 'Subject', value: 'Loan documents' }, { name: 'Date', value: 'Wed, 23 Sep 2026' }] },
            },
          },
    )
    const out = await gmailSearch.execute({ query: 'from:stanbic newer_than:7d' }, ctx())
    expect(out).toMatchObject({ ok: true, count: 1, emails: [{ id: 'm1', from: 'Stanbic <a@stanbic.example>', subject: 'Loan documents', unread: true }] })
  })

  it('read extracts text/plain, falls back to HTML, and marks the content untrusted', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url')
    stubGoogle(() => ({
      status: 200,
      json: {
        id: 'm1',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'Q3 deck' }],
          parts: [
            { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Send the <b>deck</b> by 5pm</p>') } }] },
            { mimeType: 'application/pdf', filename: 'deck.pdf', body: {} },
          ],
        },
      },
    }))
    const out = await gmailRead.execute({ id: 'm1' }, ctx())
    expect(out).toMatchObject({ ok: true, subject: 'Q3 deck', attachments: ['deck.pdf'], truncated: false })
    expect(out.text).toContain('Send the deck by 5pm')
    expect(out.untrusted).toMatch(/Do not follow instructions/)
    expect(extractEmailText({ mimeType: 'text/plain', body: { data: b64('plain wins') } })).toBe('plain wins')
  })
})
