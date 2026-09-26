import { describe, expect, it } from 'vitest'
import { createLogger } from '@wa/core'
import { CloudApiClient, GraphApiError, MediaSizeError } from '../src/client.js'

const logger = createLogger({ name: 'test', level: 'silent' })

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift()!
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const base = { accessToken: 'tok', phoneNumberId: 'PNID', graphApiVersion: 'v23.0', logger }

describe('CloudApiClient', () => {
  it('posts text to the pinned Graph version with a bearer token', async () => {
    const f = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.OUT' }] } }])
    const client = new CloudApiClient({ ...base, fetch: f.impl })
    await expect(client.sendText('256770000001', 'hi')).resolves.toEqual({ messageId: 'wamid.OUT' })
    expect(f.calls[0]!.url).toBe('https://graph.facebook.com/v23.0/PNID/messages')
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ to: '256770000001', type: 'text', text: { body: 'hi' } })
  })

  it('sends interactive reply buttons', async () => {
    const f = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.BTN' }] } }])
    const client = new CloudApiClient({ ...base, fetch: f.impl })
    await expect(client.sendButtons('256770000001', 'Send?', [{ id: 'approve:x', title: 'Send' }])).resolves.toEqual({ messageId: 'wamid.BTN' })
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '256770000001',
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'Send?' }, action: { buttons: [{ type: 'reply', reply: { id: 'approve:x', title: 'Send' } }] } },
    })
  })

  it('sends a call-to-action URL button', async () => {
    const f = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.CTA' }] } }])
    const client = new CloudApiClient({ ...base, fetch: f.impl })
    await client.sendUrlButton('256770000001', 'Connect Google', 'Connect Google', 'https://x/start?s=T')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({
      type: 'interactive',
      interactive: { type: 'cta_url', body: { text: 'Connect Google' }, action: { name: 'cta_url', parameters: { display_text: 'Connect Google', url: 'https://x/start?s=T' } } },
    })
  })

  it('downloads media in two steps with the bearer token, refusing oversized media before downloading', async () => {
    const calls: { url: string; auth: string | undefined }[] = []
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization })
      if (url.includes('/v23.0/MEDIA1')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp/abc', mime_type: 'audio/ogg; codecs=opus', file_size: 3 }))
      if (url.includes('/v23.0/BIG')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp/big', file_size: 99_999_999 }))
      return new Response(new Uint8Array([4, 5, 6]))
    }) as unknown as typeof fetch
    const client = new CloudApiClient({ ...base, fetch: impl })
    expect(await client.downloadMedia('MEDIA1', { maxBytes: 100 })).toEqual({ data: new Uint8Array([4, 5, 6]), mimeType: 'audio/ogg; codecs=opus' })
    expect(calls.map((c) => c.url)).toEqual(['https://graph.facebook.com/v23.0/MEDIA1', 'https://lookaside.fbsbx.com/whatsapp/abc'])
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true)
    await expect(client.downloadMedia('BIG', { maxBytes: 100 })).rejects.toBeInstanceOf(MediaSizeError)
    expect(calls.some((c) => c.url.endsWith('/big'))).toBe(false)
  })

  it('retries 5xx and 429, then succeeds', async () => {
    const f = fakeFetch([
      { status: 500, body: {} },
      { status: 429, body: { error: { code: 130429 } } },
      { status: 200, body: { messages: [{ id: 'wamid.OUT' }] } },
    ])
    const client = new CloudApiClient({ ...base, fetch: f.impl })
    await expect(client.sendText('x', 'hi')).resolves.toEqual({ messageId: 'wamid.OUT' })
    expect(f.calls).toHaveLength(3)
  }, 20_000)

  it('does not retry permanent 4xx errors', async () => {
    const f = fakeFetch([{ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }])
    const client = new CloudApiClient({ ...base, fetch: f.impl })
    const err = await client.sendText('x', 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GraphApiError)
    expect((err as GraphApiError).code).toBe(131047)
    expect(f.calls).toHaveLength(1)
  })

  it('sends read receipt with typing indicator', async () => {
    const f = fakeFetch([{ status: 200, body: { success: true } }])
    const client = new CloudApiClient({ ...base, fetch: f.impl })
    await client.markRead('wamid.IN', { typing: true })
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
      typing_indicator: { type: 'text' },
    })
  })
})
