import type { MediaFile, TextToSpeech } from '@wa/core'
import { SpeechProviderError } from './elevenlabs.js'

/**
 * Languages Eleven Flash v2.5 speaks (cheaper and faster), keyed by the ISO 639-3 code the
 * transcript reports, mapped to the ISO 639-1 code Flash takes as a hint. Anything else,
 * including Swahili, goes to Eleven v3 (70+ languages), which reads the language from the
 * text itself.
 */
const FLASH_LANGUAGES: Record<string, string> = {
  eng: 'en', fra: 'fr', deu: 'de', spa: 'es', por: 'pt', hin: 'hi', ita: 'it', nld: 'nl',
  pol: 'pl', swe: 'sv', tur: 'tr', ara: 'ar', rus: 'ru', ukr: 'uk', ind: 'id', msa: 'ms',
  fil: 'fil', tam: 'ta', jpn: 'ja', kor: 'ko', zho: 'zh', ces: 'cs', ell: 'el', fin: 'fi',
  hrv: 'hr', slk: 'sk', dan: 'da', bul: 'bg', ron: 'ro', hun: 'hu', nor: 'no', vie: 'vi',
}

export interface ElevenLabsTtsOptions {
  apiKey: string
  /** A voice from the ElevenLabs voice library. Multilingual voices speak every supported language. */
  voiceId: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Which model and language hint a reply gets. Exported for tests. */
export function ttsModelFor(language: string | undefined): { model: string; languageCode?: string } {
  const flash = language ? FLASH_LANGUAGES[language.toLowerCase()] : 'en'
  return flash ? { model: 'eleven_flash_v2_5', languageCode: flash } : { model: 'eleven_v3' }
}

/**
 * ElevenLabs text-to-speech straight to OGG/Opus (48 kHz mono), the format Telegram and
 * WhatsApp play as a voice note, so no transcoding is needed.
 */
export function createElevenLabsTextToSpeech(opts: ElevenLabsTtsOptions): TextToSpeech {
  const fetchImpl = opts.fetch ?? fetch
  const base = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '')
  return {
    async synthesize(text, callOpts): Promise<MediaFile> {
      const { model, languageCode } = ttsModelFor(callOpts?.language)
      const url = `${base}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=opus_48000_32`
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000)
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'xi-api-key': opts.apiKey, 'Content-Type': 'application/json', Accept: 'audio/ogg' },
          body: JSON.stringify({ text, model_id: model, ...(languageCode ? { language_code: languageCode } : {}) }),
          signal: callOpts?.signal ? AbortSignal.any([callOpts.signal, timeout]) : timeout,
        })
      } catch (err) {
        throw new SpeechProviderError(`speech request failed: ${err instanceof Error ? err.message : String(err)}`, 0, true)
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => undefined)) as { detail?: { message?: string } | string } | undefined
        const detail = json?.detail
        const message = typeof detail === 'string' ? detail : (detail?.message ?? `HTTP ${res.status}`)
        throw new SpeechProviderError(`speech failed: ${message}`, res.status, res.status === 429 || res.status >= 500)
      }
      return { data: new Uint8Array(await res.arrayBuffer()), mimeType: 'audio/ogg' }
    },
  }
}
