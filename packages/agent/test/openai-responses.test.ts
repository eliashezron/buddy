import { describe, expect, it } from 'vitest'
import { createResponsesMessage, ModelProviderError, toResponsesInput } from '../src/openai-responses.js'
import { buildMessages, isTransientModelError, type CreateMessageParams } from '../src/loop.js'

const params = (over: Partial<CreateMessageParams> = {}): CreateMessageParams =>
  ({
    model: 'gpt-6-luna',
    max_tokens: 16000,
    system: [
      { type: 'text', text: 'You are a task assistant.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'This conversation is on Telegram.' },
    ],
    thinking: { type: 'adaptive' },
    betas: ['server-side-fallback-2026-07-01'],
    cache_control: { type: 'ephemeral' },
    tools: [{ name: 'calendar_list_events', description: 'List events', strict: true, input_schema: { type: 'object', properties: { from: { type: 'string' } }, required: ['from'] } }],
    messages: [
      { role: 'user', content: "What's on tomorrow?" },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_1', name: 'calendar_list_events', input: { from: '2026-09-27' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true,"count":0}' }] },
    ],
    ...over,
  }) as CreateMessageParams

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('OpenAI Responses adapter (development provider)', () => {
  it('translates the Anthropic request: instructions, history with tool calls and results, tools; drops Claude-only settings', async () => {
    const f = fakeFetch(200, { id: 'r1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Nothing tomorrow.' }] }], usage: { input_tokens: 120, output_tokens: 8 } })
    await createResponsesMessage({ apiKey: 'oc_test', baseUrl: 'https://opencode.ai/zen/', fetch: f.impl })(params())
    expect(f.calls[0]!.url).toBe('https://opencode.ai/zen/v1/responses')
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer oc_test')
    const body = JSON.parse(String(f.calls[0]!.init.body))
    expect(body).toEqual({
      model: 'gpt-6-luna',
      instructions: 'You are a task assistant.\n\nThis conversation is on Telegram.',
      input: [
        { role: 'user', content: "What's on tomorrow?" },
        { role: 'assistant', content: 'Checking.' },
        { type: 'function_call', call_id: 'call_1', name: 'calendar_list_events', arguments: '{"from":"2026-09-27"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true,"count":0}' },
      ],
      tools: [{ type: 'function', name: 'calendar_list_events', description: 'List events', parameters: { type: 'object', properties: { from: { type: 'string' } }, required: ['from'] }, strict: false }],
      max_output_tokens: 16000,
      store: false,
    })
  })

  it('turns function calls into tool_use blocks, text into text, and maps usage', async () => {
    const f = fakeFetch(200, {
      id: 'r2',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'call_9', name: 'calendar_list_events', arguments: '{"from":"2026-09-27"}' },
      ],
      usage: { input_tokens: 500, output_tokens: 20, input_tokens_details: { cached_tokens: 300 } },
    })
    const msg = await createResponsesMessage({ apiKey: 'k', baseUrl: 'https://x', fetch: f.impl })(params())
    expect(msg.stop_reason).toBe('tool_use')
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 'calendar_list_events', input: { from: '2026-09-27' } }])
    expect(msg.usage).toMatchObject({ input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 300 })
  })

  it('reports tool errors, forced "no tools", truncation, and malformed arguments', async () => {
    const f = fakeFetch(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }] })
    const call = createResponsesMessage({ apiKey: 'k', baseUrl: 'https://x', fetch: f.impl })
    const msg = await call(
      params({
        tool_choice: { type: 'none' },
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'boom', is_error: true }] }],
      }),
    )
    expect(msg.stop_reason).toBe('max_tokens')
    const body = JSON.parse(String(f.calls[0]!.init.body))
    expect(body.tool_choice).toBe('none')
    expect(body.input).toEqual([{ type: 'function_call_output', call_id: 'c', output: 'ERROR: boom' }])

    const bad = fakeFetch(200, { output: [{ type: 'function_call', call_id: 'c2', name: 't', arguments: '{not json' }] })
    const m2 = await createResponsesMessage({ apiKey: 'k', baseUrl: 'https://x', fetch: bad.impl })(params())
    expect(m2.content[0]).toMatchObject({ type: 'tool_use', input: { _unparsed: '{not json' } })
  })

  it('sends photos as input_image and PDFs as input_file, each after its label', () => {
    const messages = buildMessages(
      [{ role: 'user', text: '', attachments: [{ kind: 'image', mimeType: 'image/jpeg', data: new Uint8Array([1, 2]) }] }],
      'add both to my expenses',
      [{ kind: 'pdf', mimeType: 'application/pdf', filename: 'inv.pdf', data: new Uint8Array([3]) }],
    )
    const [item] = toResponsesInput(messages)
    expect(item).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: expect.stringContaining('The user sent a photo') },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AQI=', detail: 'auto' },
        { type: 'input_text', text: expect.stringContaining('The user sent a PDF "inv.pdf"') },
        { type: 'input_file', filename: 'inv.pdf', file_data: 'data:application/pdf;base64,Aw==' },
        { type: 'input_text', text: 'add both to my expenses' },
      ],
    })
  })

  it('maps errors so the queue retries only transient ones', async () => {
    const call = (status: number, body: unknown) => createResponsesMessage({ apiKey: 'k', baseUrl: 'https://x', fetch: fakeFetch(status, body).impl })(params())
    const rate = await call(429, { error: { message: 'slow down' } }).catch((e: unknown) => e)
    expect(rate).toBeInstanceOf(ModelProviderError)
    expect(isTransientModelError(rate)).toBe(true)
    const auth = await call(401, { error: { message: 'bad key' } }).catch((e: unknown) => e)
    expect(isTransientModelError(auth)).toBe(false)
    expect(String((auth as Error).message)).toContain('bad key')
    const net = await createResponsesMessage({
      apiKey: 'k',
      baseUrl: 'https://x',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })(params()).catch((e: unknown) => e)
    expect(isTransientModelError(net)).toBe(true)
  })
})
