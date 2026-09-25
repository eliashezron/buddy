import { describe, expect, it } from 'vitest'
import { createLogger } from '@wa/core'
import { CloudApiClient, GraphApiError } from '../src/client.js'

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
