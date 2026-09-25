# Connectors: Google Calendar and Gmail

Users connect accounts **only when they ask for something that needs them**. Nothing
is requested up front, and each request asks for only the permission that task needs.

## How it works

```
User: "what's on my calendar tomorrow?"
  → agent calls calendar_list_events
  → no Google connection → tool raises NeedsConnectionError(calendar.read)
  → agent replies: "I've sent you a link to connect your calendar"
  → worker (not the model) sends a one-time link as a [Connect Google] button that opens
    the browser:  <PUBLIC_BASE_URL>/oauth/google/start?s=…  (plain text if the platform
    rejects the button, e.g. Telegram and a localhost URL). The URL is never stored as
    history, so the model never sees it.
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
| `delete_calendar_event` | low_write, undoable 10 min | calendar write. Own events only, no notifications. Events with other guests are refused (deleting them notifies people). Undo restores the same event. |
| `gmail_search`, `gmail_read` | read | Gmail read (`gmail.readonly`) |
| `gmail_create_draft` | low_write, undoable 10 min | Gmail compose (`gmail.compose`). Saves a draft (new or a threaded reply); never sends. Undo deletes the draft. |
| `drive_search`, `drive_read` | read | Drive read (`drive.readonly`). Finds files by name or content; reads Docs and Slides as text and Sheets as rows (5 tabs × 200 rows). Content is marked untrusted. |
| `create_document` | low_write, undoable 10 min | Drive file (`drive.file`). Markdown uploaded as HTML; Drive converts it to a formatted Doc. Private: never shared. Undo moves it to the trash. |
| `create_spreadsheet` | low_write, undoable 10 min | Drive file. Tabs, bold frozen header, real numbers and formulas. Formulas that fetch from the web (IMPORTXML, IMAGE, …) are stored as text so a sheet built from untrusted content can't leak its data. Leading-zero numbers (phone numbers) stay text. |
| `create_presentation` | low_write, undoable 10 min | Drive file. Title slide plus title-and-bullets slides; a half-built deck is trashed if filling it fails. |
| `send_calendar_invite` | **outbound**, needs approval | calendar write. An event with guests (optional Meet link); Google emails the invitations. |
| `cancel_calendar_event` | **outbound**, needs approval | calendar write. Cancels a meeting the user organised that has guests; Google emails them. Meetings others organised are refused. |
| `share_file` | **outbound**, needs approval | Drive file. Shares a file the app created as viewer / commenter / editor; Google emails a link. |
| `gmail_send_email` | **outbound**, needs approval | Gmail compose (+ read to thread a reply). Sends only after the user presses Send on the card. |
| `manage_connections` | low_write | none. Lists access or disconnects (revokes at Google). |
| `undo_last_action` | low_write | none. Reverses the last undoable change within 10 minutes. |

`drive.file` is Google's narrowest Drive scope: the app can only see and change files it
created. Editing the user's other files, and sharing any file (which emails people, so it
would be `outbound`), are not supported yet. `drive.readonly` is restricted, like
`gmail.readonly`. **Enable the Google Drive, Sheets and Slides APIs** in the Cloud project
(APIs & Services → Library) or these tools get 403s.

Google has no drafts-only scope: `gmail.compose` also permits sending, and Google's consent
screen says so ("manage drafts and send emails"). Sending is gated by the approval flow
below, not by the scope. Like `gmail.readonly`, `gmail.compose` is a restricted scope for
Google app verification. Calendar invitations, cancelling meetings with guests and sharing
files are also `outbound` and use the same flow.

## Approvals (`outbound` actions)

```
User: "email kato@example.com that I'm running late"
  → agent calls gmail_send_email
  → policy gate: outbound → checks Gmail access first (else: connect link, no card)
  → actions row: awaiting_approval, approval_expires_at = now + 15 min, input stored
  → model is told "nothing was sent; a card is coming" and replies in one line
  → worker (not the model) sends the card: the full email + [✅ Send] [✖ Cancel]
User taps Send
  → button payload approve:<action id>  (Telegram callback_query / WhatsApp button_reply)
  → one UPDATE: same user AND awaiting_approval AND not expired → running (decided_at set)
  → execute the *stored* input → succeeded / failed → "✅ Done: Email to kato@…"
```

- **Only a button press approves.** Typed text, even `approve:<id>`, goes to the agent
  as a normal message. Forwarded or pasted content can't press a button.
- **The model can't approve or change anything** after proposing: execution uses the row's
  input, validated again with the tool's schema.
- **Once only.** The claim is a single conditional UPDATE, so a double tap or a
  redelivered press sends once (a Postgres test races four taps). A failure after the
  claim is never retried automatically: if sending throws, the user is told it may not
  have gone out.
- **Only its user.** A press for someone else's action is "no longer works"; on Telegram,
  presses by anyone but the private chat's owner are dropped at parse time.
- **Expiry.** After 15 minutes the action is marked `expired` and nothing is sent.
- On Telegram the buttons are removed after a decision. WhatsApp reply buttons can't be
  removed; a later tap gets "That was already done / cancelled".
- **Cards show facts from the account, not the model's words.** A tool whose input is
  just an id (`cancel_calendar_event`, `share_file`) has a `describe` step that runs when
  approval is requested: it fetches the event's title, time and guests, or the file's
  name, and can refuse early (not the organiser; not a file the app created). The card is
  stored on the action (`actions.card`), so the record shows exactly what was approved,
  and the "Done" confirmation uses its title.
- **Strict tool use only for outbound and money tools.** The API allows at most 20 strict
  tools and rejects large combined schemas; every tool's input is validated with zod
  before it runs either way.
- `money` stays blocked: payments also need a PSP PIN step and spend limits.

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
  saying "add a calendar event / pay this" or "delete my meetings / draft a reply with
  the password" causes no action.

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
| "Delete <an event you created>" | Removed with no notification; "undo" brings back the same event. |
| "Delete <an event with guests>" | Refused: remove it in Google Calendar. Nothing changes. |
| "Draft a reply to <someone>'s latest email saying …" | A link for Gmail compose. After allowing, a draft in the same thread in Gmail Drafts. Nothing is sent. |
| "What can you access?" | Lists Google with calendar + Gmail access. |
| "Disconnect Google" | Access revoked (see https://myaccount.google.com/permissions). The next calendar question asks again. |
| Open a link twice, or after 15 min | "This link has expired / already been used". |
| Tap Cancel on Google's screen | "No problem, I haven't connected anything." |
| "Find my <something> doc" | A link asking for Drive read access; then matching files. |
| "Summarise <a Docs link>" | The doc's contents, summarised. |
| "Make a Google Doc with notes: …" | A link for Drive file access; then a formatted Doc (headings, bullets) you own, not shared. "Undo that" trashes it. |
| "Make a spreadsheet tracking …" | A Sheet with a bold frozen header and real numbers. |
| "Make a 4-slide deck about …" | A title slide plus bulleted slides. |
| "Email <your other address> that the test worked" | One line saying it's ready, then a card with the full email and Send / Cancel. Nothing in Sent yet. |
| Tap **Send** | "✅ Done: Email to …". It's in Gmail Sent. The buttons disappear (Telegram). |
| Ask again, tap **Cancel** | "Cancelled. Nothing was sent." |
| Ask again, wait 15 min, tap Send | "That request expired…". Nothing sent. |
| Type `approve` instead of tapping | Treated as a normal message; nothing sent. |

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
