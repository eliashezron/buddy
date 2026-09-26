import { describe, expect, it } from 'vitest'
import { createElevenLabsTextToSpeech, ttsModelFor } from '../src/elevenlabs-tts.js'
import { SpeechProviderError } from '../src/elevenlabs.js'

describe('ElevenLabs text-to-speech', () => {
  it('routes by the transcript language: Flash with a hint where it speaks the language, v3 otherwise (e.g. Swahili)', () => {
    expect(ttsModelFor('eng')).toEqual({ model: 'eleven_flash_v2_5', languageCode: 'en' })
    expect(ttsModelFor('spa')).toEqual({ model: 'eleven_flash_v2_5', languageCode: 'es' })
    expect(ttsModelFor('HIN')).toEqual({ model: 'eleven_flash_v2_5', languageCode: 'hi' })
    expect(ttsModelFor('swa')).toEqual({ model: 'eleven_v3' })
    expect(ttsModelFor('lug')).toEqual({ model: 'eleven_v3' })
    // Typed messages carry no language: English Flash.
    expect(ttsModelFor(undefined)).toEqual({ model: 'eleven_flash_v2_5', languageCode: 'en' })
  })

  it('asks for OGG/Opus (a voice note on both channels, no transcoding) and returns the bytes', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchStub = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(new Uint8Array([79, 103, 103, 83])))) as unknown as typeof fetch
    const out = await createElevenLabsTextToSpeech({ apiKey: 'xi', voiceId: 'VOICE1', fetch: fetchStub }).synthesize('Habari, karibu.', { language: 'swa' })
    expect(out).toEqual({ data: new Uint8Array([79, 103, 103, 83]), mimeType: 'audio/ogg' })
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/VOICE1?output_format=opus_48000_32')
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'Habari, karibu.', model_id: 'eleven_v3' })
  })

  it('classifies failures so the caller can fall back to text', async () => {
    const run = (status: number) =>
      createElevenLabsTextToSpeech({ apiKey: 'k', voiceId: 'v', fetch: (async () => new Response(JSON.stringify({ detail: { message: 'quota' } }), { status })) as unknown as typeof fetch })
        .synthesize('x')
        .then(() => { throw new Error("expected a failure") }, (e: unknown) => e as SpeechProviderError)
    expect((await run(429)).transient).toBe(true)
    const quota = await run(401)
    expect(quota).toBeInstanceOf(SpeechProviderError)
    expect(quota.transient).toBe(false)
  })
})
