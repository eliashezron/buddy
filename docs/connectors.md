# Connectors: Google Calendar and Gmail

Users connect accounts **only when they ask for something that needs them**. Nothing
is requested up front, and each request asks for only the permission that task needs.

## How it works

```
User: "what's on my calendar tomorrow?"
  → agent calls calendar_list_events
  → no Google connection → tool raises NeedsConnectionError(calendar.read)
  → agent replies: "I've sent you a link to connect your calendar"
  → worker (not the model) sends a one-time link:  <PUBLIC_BASE_URL>/oauth/google/start?s=…
User taps it
  → /oauth/google/start checks the link (unused, <15 min old) → 302 to Google
    asking only for calendar.events.readonly (+ openid email), with PKCE
  → Google consent → /oauth/google/callback
  → link consumed (single use), code exchanged, granted scopes checked
  → tokens encrypted and stored; "✅ Connected Google Calendar (you@gmail.com)"
  → the original request re-runs automatically and the answer arrives in chat
Later: "book focus time Friday 2pm"
  → create_calendar_event needs calendar.write → a new link asks only for that
    (incremental authorization keeps the earlier grant)
```

| Tool | Risk | Needs |
| --- | --- | --- |
| `calendar_list_events` | read | calendar read (`calendar.events.readonly`) |
| `create_calendar_event` | low_write, undoable 10 min | calendar write (`calendar.events`). Private events only: no guests, no notifications. |
| `gmail_search`, `gmail_read` | read | Gmail read (`gmail.readonly`) |
| `manage_connections` | low_write | none. Lists access or disconnects (revokes at Google). |
| `undo_last_action` | low_write | none. Reverses the last undoable change within 10 minutes. |

Sending email and inviting people are `outbound`: they need the approval-buttons flow
(not built yet), so the agent offers drafts instead.

**Security**
- Refresh and access tokens are encrypted with AES-256-GCM. Each ciphertext is bound
  to its user and token type (AAD), so rows can't be swapped.
- Connect links: 256-bit random token, only its SHA-256 hash stored, 15-minute
  expiry, consumed atomically (single use), PKCE (S256).
- Pages are `no-store`, `no-referrer`, strict CSP.
- Granted scopes are checked after consent. Users can untick boxes on Google's screen,
  and the bot says what wasn't allowed.
- A revoked grant (`invalid_grant`, or a 401 from Google) deletes the stored tokens,
  and the next request sends a fresh link.
- Email and event text is untrusted content. An adversarial eval checks that an email
  saying "add a calendar event / pay this" causes no action.

## Local setup (one-time, about 10 minutes)

1. **Google Cloud project:** open https://console.cloud.google.com and create a
   project (for example `buddy-dev`).
2. **Enable the APIs:** *APIs & Services → Library*: enable **Google Calendar API** and
   **Gmail API**.
3. **Consent screen:** *Google Auth Platform → Branding / Audience*:
   - User type **External**, publishing status **Testing**.
   - App name and support email.
   - **Test users:** add the Google accounts you'll test with (up to 100).
4. **Data access (scopes):** add `.../auth/calendar.events.readonly`,
   `.../auth/calendar.events`, `.../auth/gmail.readonly`, `openid` and `email`.
5. **OAuth client:** *Clients → Create client* → **Web application**. Add the authorised
   redirect URI `http://localhost:3000/oauth/google/callback`. Copy the client id and secret.
6. **`.env`:**
   ```sh
   GOOGLE_CLIENT_ID=….apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)   # paste the output
   PUBLIC_BASE_URL=http://localhost:3000
   ```
7. **A dev Telegram bot** (production owns @usemiloBot's webhook): create one with
   @BotFather, then set `TELEGRAM_BOT_TOKEN=<dev bot token>` and `TELEGRAM_MODE=polling`.
8. `pnpm db:migrate && pnpm dev`. The worker logs `"google":true`.

**Test from the same computer** (Telegram Desktop or web.telegram.org). The connect link
points at `localhost:3000`, which a phone can't reach.

### What to try

| Message | Expect |
| --- | --- |
| "What's on my calendar tomorrow?" | Reply plus a 🔐 link. Tap it, allow **only** calendar read. You get "✅ Connected…", then your events. |
| "Block 2 hours for focus time on Friday at 2pm" | A new link for write access only. After allowing, the event is created. Check Google Calendar. |
| "Undo that" | The event disappears (within 10 min). |
| "Any emails from <someone> this week?" | A link for Gmail read. After allowing, a summary. |
| "What can you access?" | Lists Google with calendar + Gmail access. |
| "Disconnect Google" | Access revoked (see https://myaccount.google.com/permissions). The next calendar question asks again. |
| Open a link twice, or after 15 min | "This link has expired / already been used". |
| Tap Cancel on Google's screen | "No problem, I haven't connected anything." |

## Before production

- **KMS:** CLAUDE.md requires OAuth tokens encrypted with a KMS-backed key. The local
  AES key (`createLocalCipher`) sits behind the `TokenCipher` interface. Swap in a KMS
  implementation (e.g. envelope encryption with AWS KMS or GCP Cloud KMS) before real
  users connect accounts. **Hand review required** (token storage).
- **Google verification:** `gmail.readonly` is a *restricted* scope and the calendar
  scopes are *sensitive*. Past 100 test users you need Google's app verification, and
  for Gmail an independent security assessment. In Testing mode Google also expires
  refresh tokens after about a week, so testers will be asked to reconnect.
- **Render:** add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`
  and `PUBLIC_BASE_URL=https://<buddy-api>.onrender.com` to the `buddy-shared` env group,
  and add `https://<buddy-api>.onrender.com/oauth/google/callback` as a redirect URI on
  the OAuth client. Without `GOOGLE_CLIENT_ID` the connectors stay off, so merging this
  changes nothing in production until then.
