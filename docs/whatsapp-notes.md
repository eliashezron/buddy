# WhatsApp Cloud API — implementation notes

Platform rules and API mechanics for this project. `docs/PRD.md` says what we build;
this file says how WhatsApp works and where it bites.

> **Verification status.** Meta's developer documentation requires a login, so the
> payload shapes and field names below came from implementation guides and from the
> publicly readable Meta pages on Coexistence and Calling. Treat every JSON shape here
> as *expected*, not confirmed. While building T2 and T5, check each field against
> Meta's own reference, then capture real payloads from the test number and commit them
> to `fixtures/`, replacing the hand-written ones.

---

## 1. Ground rules (product-level, not negotiable)

- **Official Cloud API only.** No Baileys, whatsmeow, WhatsApp Web automation, or any
  reverse-engineered client. Using one puts the *user's* number at risk of a ban and
  breaks WhatsApp's Terms.
- **We never read a user's personal inbox.** The assistant sees messages sent to its
  own number, content the user forwards or uploads, and — in business mode — the
  officially connected business number's 1:1 chats.
- **AI-provider clause.** WhatsApp's Business Solution Terms bar providers whose
  *primary* function is a general-purpose AI assistant (Meta decides, "in its sole
  discretion"). Exception: EEA and Brazil numbers. Implications for the codebase:
  - Web lookups are tied to tasks. No open-ended chat or trivia mode.
  - Business/task automation is the visible product surface.
  - The channel gateway must stay channel-agnostic, so Telegram/SMS can be swapped in.
- **No training on WhatsApp data**, including anonymised or aggregated forms. Model
  vendors must be under zero-retention, no-training terms. Fine-tuning for our own
  exclusive internal use is the only permitted case.

---

## 2. Account setup checklist

1. Meta Business portfolio (Business Manager) for the company.
2. Meta app of type Business, with the WhatsApp product added.
3. WhatsApp Business Account (WABA) + a phone number that is **not** currently active
   on the WhatsApp or WhatsApp Business app.
4. Test number from the app dashboard for development (free messages to a few
   allow-listed recipients).
5. **Permanent access token** via a System User in Business Settings, with
   `whatsapp_business_messaging` and `whatsapp_business_management`. Do not ship the
   24-hour dev token.
6. App Secret (for webhook signatures) and a self-chosen Verify Token.
7. Webhook URL subscribed to the `messages` field on the WABA. For business mode also
   subscribe `smb_message_echoes` and `history`.
8. Display name submitted and approved; business verification before public launch.

### Limits before verification

| State | New contacts / 24 h | Numbers |
| --- | --- | --- |
| Unverified | 250 | 2 |
| Verified | 1,000, then automatic tier increases | more |

Replies inside the 24-hour service window do **not** count toward these limits. Meta
re-evaluates tier eligibility roughly every 6 hours when you use ≥50% of the current
limit with a good quality rating.

Verification documents: a business licence, certificate of incorporation, or tax/VAT
certificate; plus a utility bill or bank statement for address. In Uganda: URSB
certificate + URA TIN certificate; utility bill or bank statement in the company name.

---

## 3. Environment variables

```
GRAPH_API_VERSION=v23.0            # pin it; upgrade deliberately
WHATSAPP_PHONE_NUMBER_ID=          # from the app dashboard
WHATSAPP_WABA_ID=
WHATSAPP_ACCESS_TOKEN=             # system user permanent token
WHATSAPP_APP_SECRET=               # for X-Hub-Signature-256
WHATSAPP_VERIFY_TOKEN=             # our own string, used in the GET handshake
```

---

## 4. Receiving: the webhook

### 4.1 Verification handshake (GET)

Meta calls the webhook URL with query params:

| Param | Value |
| --- | --- |
| `hub.mode` | `subscribe` |
| `hub.verify_token` | must equal `WHATSAPP_VERIFY_TOKEN` |
| `hub.challenge` | random string |

Respond `200` with `hub.challenge` as the **raw body** (plain text, not JSON). Any
mismatch returns `403`.

### 4.2 Signature verification (POST)

Every POST carries `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the **raw
request body** keyed with the App Secret.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string) {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  const received = Buffer.from(header.slice(7), 'hex')
  return expected.length === received.length && timingSafeEqual(expected, received)
}
```

Fastify must be configured so this route keeps the raw body — register a
`preValidation`/`onRequest` hook or a raw-body plugin scoped to `/webhook`. Verifying
against re-serialised JSON will fail intermittently and waste a day.

### 4.3 Payload shape

```jsonc
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
        "contacts": [{ "profile": { "name": "Elias" }, "wa_id": "2567..." }],
        "messages": [ /* inbound */ ],
        "statuses": [ /* delivery events */ ]
      }
    }]
  }]
}
```

**Iterate every array.** Under load Meta batches several messages into one webhook;
processing only `entry[0].changes[0].value.messages[0]` silently drops messages.

Inbound `messages[]` items always carry `from`, `id`, `timestamp`, `type`. The body
lives under a key named after the type:

| `type` | Payload key | Notes |
| --- | --- | --- |
| `text` | `text.body` | |
| `audio` | `audio.{id,mime_type,voice}` | `voice: true` = recorded note; OGG/Opus |
| `image`, `document`, `video`, `sticker` | `<type>.{id,mime_type,caption?}` | media by id |
| `interactive` | `interactive.button_reply.{id,title}` or `interactive.list_reply` | our approval buttons |
| `button` | `button.{payload,text}` | template quick-reply buttons |
| `location`, `contacts`, `reaction`, `order`, `system` | see reference | later milestones |

A reply to one of our messages carries `context.id` = the original message id. Use it
to tie an approval to its pending action, alongside the button payload.

`statuses[]` items: `id`, `status` (`sent` | `delivered` | `read` | `failed`),
`timestamp`, `recipient_id`, plus `conversation` and `pricing` objects, and `errors[]`
when failed.

### 4.4 Delivery semantics

- **At-least-once, unordered.** Deduplicate on `messages[].id` / `statuses[].id`
  (Redis key, TTL a few days). Never assume chronological arrival; sort by `timestamp`.
- **Retries** use exponential backoff. Sources disagree on the window (36 hours vs up
  to 7 days) — design for "retried for a long time" and stay idempotent.
- **Respond fast.** Return 200 within a couple of seconds (Meta's guidance is under
  10 s). Pattern: verify → dedup → enqueue → 200. Never run a model call, an ASR job
  or a DB migration inside the handler.
- A non-200 or a timeout triggers redelivery, so a slow handler creates duplicate
  processing storms. This is the single most common production failure here.

---

## 5. Sending

```
POST https://graph.facebook.com/{GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json
```

**Text**

```json
{ "messaging_product": "whatsapp", "to": "2567...", "type": "text",
  "text": { "body": "Booked: Coffee with Amina, Fri 25 Sep 10:00.", "preview_url": false } }
```

**Interactive buttons** — our approval primitive. Maximum 3 buttons, title ≤ 20 chars,
`id` ≤ 256 chars (we encode `approve:<action_id>`):

```json
{ "messaging_product": "whatsapp", "to": "2567...", "type": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "Pay Umeme UGX 184,000 from MTN ...321?" },
    "action": { "buttons": [
      { "type": "reply", "reply": { "id": "approve:act_123", "title": "Approve" } },
      { "type": "reply", "reply": { "id": "edit:act_123",    "title": "Change" } },
      { "type": "reply", "reply": { "id": "cancel:act_123",  "title": "Cancel" } }
    ] } } }
```

For more than 3 options use `"type": "list"` (up to 10 rows). For multi-field input
(amount + payee + reference) use **WhatsApp Flows** rather than a chat back-and-forth.

**Audio reply** — upload first (`POST /{PHONE_NUMBER_ID}/media`, multipart, returns an
id), then send `{"type":"audio","audio":{"id":"<media_id>"}}`.

**Typing indicator and read receipts** — mark the inbound message read and show typing
while the agent works, so the assistant doesn't feel dead during a 5-second model call.

**Reliability**: retry 5xx and 429 with backoff and jitter; treat 4xx as permanent
except 429. Record the returned `messages[0].id` so `statuses[]` can be matched later.

---

## 6. Media download

Inbound media is an **id**, not a file:

1. `GET /{GRAPH_API_VERSION}/{MEDIA_ID}` → `{ url, mime_type, sha256, file_size }`
2. `GET {url}` with the `Authorization: Bearer` header → the bytes

The URL expires in about 5 minutes, so download immediately and store it yourself
(object storage, encrypted, with the retention policy from the PRD). Voice notes are
OGG/Opus; convert with ffmpeg if the ASR vendor needs WAV or MP3.

---

## 7. The 24-hour window and templates

- A user message opens a **24-hour customer service window**. Inside it, free-form
  replies of any type are allowed.
- Outside it, only **pre-approved template messages** may be sent. Attempting a
  free-form send returns a re-engagement error.
- Track `users.last_inbound_at` and check it in the sender, not in the caller. Outside
  the window the sender either switches to a template or queues the message until the
  user next writes.
- Template categories: **utility** (our daily brief, reminders, receipts), **marketing**
  (re-engagement, seller campaigns), **authentication**. Categories are priced
  differently and marketing templates are more likely to be rejected or blocked.
- Templates need submission and approval before use, and approval takes time. Submit
  the daily-brief template in week 1 of M1, before the code that needs it exists.
- Template variables are positional (`{{1}}`, `{{2}}`). Keep a registry in code —
  name, language, category, variable order, approval status — and never build template
  payloads ad hoc.

---

## 8. Business mode (Coexistence)

Confirmed from Meta's Coexistence documentation:

- Onboarding is Embedded Signup with the Coexistence flow; the seller scans a QR code
  in the WhatsApp Business app and keeps using it.
- History sync brings **180 days** of 1:1 messages; **media only for the first 14
  days**. Sync must complete within 24 h of onboarding or the business must be
  offboarded and redone.
- `smb_message_echoes` delivers messages the seller sends from the app — this is how we
  detect a human reply and stop the AI.
- **Group chats are not supported.** Throughput is fixed at **20 messages per second**.
- Disappearing messages, view-once, live location and broadcast lists are disabled on
  the number after onboarding. Broadcasts must move to API marketing templates.
- WhatsApp for Windows and WearOS are unsupported companion devices.

---

## 9. Calling (later milestone)

From Meta's Cloud API Calling documentation:

- **User-initiated** calls to the business number work anywhere Cloud API is available.
- **Business-initiated** calls are unavailable from numbers in the US, Canada, Egypt,
  Vietnam and Nigeria. Uganda is fine, but check before a Nigeria launch.
- Media is WebRTC (ICE/DTLS/SRTP) or SIP, OPUS plus PCMA/PCMU.
- This gives live voice mode with our own number. It gives **no** access to the user's
  other calls — call summaries still come from a voice-note debrief.

---

## 10. Error codes seen in the wild

Commonly reported; confirm against Meta's error reference when implementing handling.

| Code | Meaning | Our handling |
| --- | --- | --- |
| 131047 | Re-engagement required (24 h window closed) | Switch to a template; log as a window-guard bug |
| 131026 | Message undeliverable (recipient not on WhatsApp, or number invalid) | Mark the user unreachable; surface in admin |
| 131051 | Unsupported message type | Reply with a graceful "I can't read that yet" |
| 132000/132001 | Template parameter mismatch or template not found | Fail the job loudly; templates are code |
| 130429 | Rate limit hit | Backoff + jitter; check tier |
| 131056 | Pair rate limit (too many messages to one user) | Throttle per-user sends |
| 190 | Access token expired or invalid | Alert; permanent tokens shouldn't expire |
| 133010 | Phone number not registered | Registration step missed in setup |

---

## 11. Local development and testing

- Tunnel for webhooks: `cloudflared tunnel --url http://localhost:3000` or ngrok.
  Re-subscribe the webhook URL whenever the tunnel URL changes.
- `pnpm replay <fixture>` feeds a saved payload through the full inbound pipeline,
  computing a valid signature from `WHATSAPP_APP_SECRET` so the signature path is
  exercised too.
- `packages/whatsapp` exports a fake client that records outbound calls. No test may
  hit the live Graph API.
- `/dev/simulate` (env-flagged) accepts a plain string and runs it as an inbound text
  message — the fastest loop when iterating on prompts.
- Capture real payloads early: send one of each type (text, voice note, image,
  button reply) from your phone to the test number, log the raw body, and commit them.

---

## 12. Open items to verify before M1 ships

- [ ] Field names and shapes in §4.3 against Meta's webhook reference.
- [ ] Current Graph API version, and what changed in the two before it.
- [ ] Exact webhook retry window (36 h vs 7 days) and whether ordering is ever guaranteed.
- [ ] Any mTLS / certificate-authority requirement for webhook endpoints — Meta
      announced a CA change effective 2026; confirm our endpoint's trust store complies.
- [ ] Whether our use case passes a BSP's review of the AI-provider clause, in writing.
- [ ] Template approval times for utility templates in our market.

---

## Sources

- [WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) — AI-provider clause, no-training rule
- [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service) — why unofficial clients are out
- [Meta for Developers — Onboard WhatsApp Business app users (Coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Meta for Developers — Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling)
- [Hookdeck — WhatsApp webhooks guide](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices)
- [Chatarmin — WhatsApp webhooks](https://chatarmin.com/en/blog/whatsapp-webhooks) · [messaging limits](https://chatarmin.com/en/blog/whats-app-messaging-limits)
- [Infobip — business verification](https://www.infobip.com/docs/whatsapp/get-started/business-verification)
