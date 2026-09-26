# Voice notes

**Voice in (PRD F2):** a user sends a voice note on Telegram or WhatsApp; the assistant
transcribes it and handles the text exactly as if it had been typed. Voice replies (F3)
come next.

```
voice note (Telegram voice / WhatsApp audio)
  → worker: over 5 min (Telegram reports duration; WhatsApp is capped at 16 MB)? → "too long" reply
  → channel.downloadMedia: Telegram getFile + file URL (bot token, never logged);
    WhatsApp GET /{media-id} → short-lived URL (~5 min) → GET with the bearer token
  → SpeechToText.transcribe (ElevenLabs Scribe v2, language auto-detected)
  → empty → "couldn't make it out"; transient error → queue retry; last attempt → apology
  → transcript stored as the message body (history reads like typed text)
  → agent runs on the transcript as usual
  → approval cards start with 🎙️ You said: "…" so a mis-heard name or amount is caught
```

- **Never logged:** audio and transcripts are content (CLAUDE.md). Logs carry duration,
  detected language and character count only. The audio is held in memory, not stored.
- **Off unless configured:** without `ELEVENLABS_API_KEY`, voice notes get the "not yet"
  reply. `STT_MODEL` defaults to `scribe_v2`.
- **Languages:** Scribe transcribes 99 languages, including English, Swahili, Luganda,
  Hindi, Spanish and Portuguese, and detects the language itself, so code-switched and
  multilingual users need no setting. Sunbird AI (Ugandan languages) can be added behind
  the same `SpeechToText` interface.

## Retention (decide before enabling in production)

ElevenLabs' zero-retention mode (`enable_logging=false`) is **Enterprise-only**, so it is
not sent; on other plans ElevenLabs keeps request data under its standard terms. Voice
notes are user content, so this falls under CLAUDE.md's zero-retention non-negotiable,
like the model vendor. The owner's exception recorded there covers OpenCode only: extend
it explicitly (or move to Enterprise / another vendor) before setting
`ELEVENLABS_API_KEY` on Render.

## Local test

1. Set `ELEVENLABS_API_KEY` in `.env` and restart `pnpm dev` (the worker logs `"voice":true`).
2. Send the dev bot a voice note: "what's the dollar rate today?" → it answers as if typed.
3. A voice note asking to email someone → the card starts with 🎙️ You said: "…".
4. A silent note → "I couldn't make out that voice note…".
