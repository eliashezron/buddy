import type { MediaFile, SpeechToText, Transcript } from '@wa/core'
import { z } from 'zod'

const responseSchema = z.object({
  text: z.string().default(''),
  language_code: z.string().optional(),
  language_probability: z.number().optional(),
})

export class SpeechProviderError extends Error {
  override name = 'SpeechProviderError'
  constructor(
    message: string,
    readonly status: number,
    /** Worth retrying later: rate limits, server errors, network failures. */
    readonly transient: boolean,
  ) {
    super(message)
  }
}

export interface ElevenLabsOptions {
  apiKey: string
  /** Scribe model, e.g. scribe_v2. */
  model?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const EXTENSION: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
}

/**
 * ElevenLabs Scribe speech-to-text (99 languages, incl. English, Swahili, Luganda, Hindi,
 * Spanish, Portuguese). The language is detected, not configured, so code-switched and
 * multilingual users need no setting.
 *
 * Retention: zero-retention mode (enable_logging=false) is Enterprise-only, so it is not
 * sent; ElevenLabs keeps request data under its standard terms (see docs/voice.md).
 */
export function createElevenLabsSpeechToText(opts: ElevenLabsOptions): SpeechToText {
  const fetchImpl = opts.fetch ?? fetch
  const url = `${(opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '')}/v1/speech-to-text`
  return {
    async transcribe(audio: MediaFile, callOpts): Promise<Transcript> {
      const mime = audio.mimeType.split(';')[0]!.trim().toLowerCase()
      const form = new FormData()
      form.set('model_id', opts.model ?? 'scribe_v2')
      form.set('tag_audio_events', 'false')
      form.set('file', new Blob([audio.data], { type: mime }), `voice.${EXTENSION[mime] ?? 'ogg'}`)
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000)
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'xi-api-key': opts.apiKey },
          body: form,
          signal: callOpts?.signal ? AbortSignal.any([callOpts.signal, timeout]) : timeout,
        })
      } catch (err) {
        throw new SpeechProviderError(`transcription request failed: ${err instanceof Error ? err.message : String(err)}`, 0, true)
      }
      const json: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        const detail = (json as { detail?: { message?: string } | string } | undefined)?.detail
        const message = typeof detail === 'string' ? detail : (detail?.message ?? `HTTP ${res.status}`)
        throw new SpeechProviderError(`transcription failed: ${message}`, res.status, res.status === 429 || res.status >= 500)
      }
      const parsed = responseSchema.parse(json)
      return {
        text: parsed.text.trim(),
        ...(parsed.language_code ? { language: parsed.language_code } : {}),
        ...(parsed.language_probability !== undefined ? { languageProbability: parsed.language_probability } : {}),
      }
    },
  }
}
