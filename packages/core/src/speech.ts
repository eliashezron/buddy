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

/** Voice replies (PRD F3): text → an OGG/Opus voice note. */
export interface TextToSpeech {
  /** `language` is an ISO 639 code from the transcript, when the user spoke. */
  synthesize(text: string, opts?: { language?: string; signal?: AbortSignal }): Promise<MediaFile>
}

/** How the assistant replies: in the user's mode (voice note → voice), or always text / voice. */
export const REPLY_MODES = ['match', 'text', 'voice'] as const
export type ReplyMode = (typeof REPLY_MODES)[number]

/** A voice note the assistant won't process (too long, too large, unsupported). */
export class MediaTooLargeError extends Error {
  override name = 'MediaTooLargeError'
}
