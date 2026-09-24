import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger, noServices } from '@wa/core'
import { extractText, fetchPage } from '../src/fetch-page.js'

const ctx = {
  userId: 'u',
  runId: 'r',
  actionId: 'a',
  timezone: 'Africa/Kampala',
  now: new Date(),
  logger: createLogger({ name: 'test', level: 'silent' }),
  services: noServices(),
}

describe('extractText', () => {
  it('extracts title and readable text from HTML, dropping scripts and nav', () => {
    const html = '<html><head><title>Kololo Venues</title><script>evil()</script></head><body><nav>Menu</nav><h1>Halls</h1><p>Seats 20.</p></body></html>'
    const out = extractText('text/html; charset=utf-8', Buffer.from(html))
    expect(out?.title).toBe('Kololo Venues')
    expect(out?.text).toContain('Seats 20.')
    expect(out?.text).not.toContain('evil')
    expect(out?.text).not.toContain('Menu')
  })

  it('returns null for binary types', () => {
    expect(extractText('application/pdf', Buffer.from('%PDF'))).toBeNull()
  })
})

describe('fetch_page', () => {
  let server: ReturnType<typeof createServer>
  let url: string
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('<html><title>internal</title></html>'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('never reaches a local server', async () => {
    const out = await fetchPage.execute({ url }, ctx)
    expect(out.ok).toBe(false)
    expect(out).toMatchObject({ error: expect.stringMatching(/^blocked/) })
  })

  it('refuses hostnames that resolve to private addresses at connect time', async () => {
    // 'localhost.' (trailing dot) passes the name check, so this exercises the DNS-level guard.
    const out = await fetchPage.execute({ url: 'http://localhost./' }, ctx)
    expect(out.ok).toBe(false)
  })
})
