import { describe, expect, it } from 'vitest'
import { createElevenLabsSpeechToText, SpeechProviderError } from '../src/elevenlabs.js'

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch
  return { impl, calls }
}
const audio = { data: new Uint8Array([79, 103, 103, 83]), mimeType: 'audio/ogg; codecs=opus' }

describe('ElevenLabs speech-to-text', () => {
  it('posts the audio as multipart with the model and key, and returns text and detected language', async () => {
    const f = fakeFetch(200, { text: ' Add lunch with Kato tomorrow at one. ', language_code: 'eng', language_probability: 0.98, words: [] })
    const out = await createElevenLabsSpeechToText({ apiKey: 'xi_test', fetch: f.impl }).transcribe(audio)
    expect(out).toEqual({ text: 'Add lunch with Kato tomorrow at one.', language: 'eng', languageProbability: 0.98 })
    expect(f.calls[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect((f.calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi_test')
    const form = f.calls[0]!.init.body as FormData
    expect(form.get('model_id')).toBe('scribe_v2')
    expect(form.get('tag_audio_events')).toBe('false')
    const file = form.get('file') as File
    expect(file.name).toBe('voice.ogg')
    expect(file.type).toBe('audio/ogg')
    expect(file.size).toBe(4)
  })

  it('names the file by type (WhatsApp sends other formats too) and honours a model override', async () => {
    const f = fakeFetch(200, { text: 'Habari' })
    await createElevenLabsSpeechToText({ apiKey: 'k', model: 'scribe_v1', fetch: f.impl }).transcribe({ data: new Uint8Array([1]), mimeType: 'audio/mpeg' })
    const form = f.calls[0]!.init.body as FormData
    expect((form.get('file') as File).name).toBe('voice.mp3')
    expect(form.get('model_id')).toBe('scribe_v1')
  })

  it('retries only rate limits, server errors and network failures', async () => {
    const run = (status: number, body: unknown) => createElevenLabsSpeechToText({ apiKey: 'k', fetch: fakeFetch(status, body).impl }).transcribe(audio).catch((e: unknown) => e)
    const limited = (await run(429, { detail: { message: 'Too many requests' } })) as SpeechProviderError
    expect(limited).toBeInstanceOf(SpeechProviderError)
    expect(limited.transient).toBe(true)
    const bad = (await run(401, { detail: { message: 'Invalid API key' } })) as SpeechProviderError
    expect(bad.transient).toBe(false)
    expect(bad.message).toContain('Invalid API key')
    const net = (await createElevenLabsSpeechToText({
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
      .transcribe(audio)
      .catch((e: unknown) => e)) as SpeechProviderError
    expect(net.transient).toBe(true)
  })
})
