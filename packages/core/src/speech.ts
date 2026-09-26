/**
 * Voice notes (PRD F2). A channel downloads the audio; a speech provider turns it into
 * text. Transcripts are message content: stored like a typed message, never logged.
 */

/** Audio bytes downloaded from a channel. Kept in memory only, never stored. */
export interface MediaFile {
  data: Uint8Array
  mimeType: string
}

export interface Transcript {
  text: string
  /** ISO 639 code of the detected language, e.g. "eng", "swa", "lug". */
  language?: string
  /** 0–1, how sure the provider is about the language. */
  languageProbability?: number
}

export interface SpeechToText {
  transcribe(audio: MediaFile, opts?: { signal?: AbortSignal }): Promise<Transcript>
}

/** A voice note the assistant won't process (too long, too large, unsupported). */
export class MediaTooLargeError extends Error {
  override name = 'MediaTooLargeError'
}
