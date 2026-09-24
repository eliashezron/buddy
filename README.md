# WhatsApp assistant

A task assistant people reach on a WhatsApp Business number (official Cloud API only)
or a Telegram bot (official Bot API). It looks things up on the web, and, once the user
allows it, works with their Google Calendar and Gmail. Access is requested only when a
request needs it (`docs/connectors.md`).
Right now it answers questions by searching the web and reading pages. Calendar,
email, Notion and payments come next. Scope: `docs/PRD.md`. Rules: `CLAUDE.md`.
Platform notes: `docs/whatsapp-notes.md`, `docs/telegram-notes.md`.

## Quick start

Needs Node 24+ and Docker.

```sh
corepack enable pnpm        # or: corepack enable --install-directory ~/.local/bin pnpm
cp .env.example .env        # then fill in the values (see below)
docker compose up -d        # Postgres 16 (+pgvector) and Redis 7
pnpm install
pnpm db:migrate
pnpm dev                    # api :3000, worker, web :3001
```

For local work without a Meta app, any non-empty placeholder works for the
`WHATSAPP_*` values. `ANTHROPIC_API_KEY` must be real for the agent to answer.

To try it on Telegram, you only need a bot token: create a bot with @BotFather, set
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_MODE=polling` in `.env`, run `pnpm dev`, and message
your bot. No tunnel is needed.

## How a message flows

```
WhatsApp → POST /webhook            verify X-Hub-Signature-256 over the raw body
Telegram → POST /telegram/webhook   verify X-Telegram-Bot-Api-Secret-Token
           (or long polling in dev)
  → parse into channel-agnostic events (packages/core/channel.ts)
  → enqueue (job id = channel + message id, so redeliveries dedupe) → 200 in a few ms
→ inbound queue (apps/worker)
  upsert user and store message, unique on (channel, external id); show typing
  → agent loop (packages/agent): Claude + tools; every tool call gets an
    `actions` row before it runs; outbound/money tools are gated by the policy
  → reply through the user's Channel: WhatsApp enforces the 24 h window;
    Telegram renders HTML
```

Tools (`packages/tools`, one file each):

| Tool | Risk | What it does |
| --- | --- | --- |
| `web_search` | read | Claude sub-call using Anthropic's server-side web search; returns findings + sources |
| `fetch_page` | read | Fetches a public URL (SSRF-guarded at DNS level), returns readable text |
| `calendar_list_events` | read | The user's Google Calendar events in a range |
| `create_calendar_event` | low_write | A private event on the user's calendar (undo for 10 min) |
| `gmail_search`, `gmail_read` | read | Search and read the user's Gmail |
| `manage_connections` | low_write | List or disconnect linked accounts |
| `undo_last_action` | low_write | Reverse the last undoable change |

## Commands

```sh
pnpm test                          # unit + integration (set TEST_DATABASE_URL for the Postgres tests)
pnpm typecheck
pnpm build
pnpm evals                         # tool-selection + adversarial evals against the live model
pnpm evals --update-baseline       # record a new baseline after an intended change
pnpm replay book-meeting           # print a fixture as Meta would send it
pnpm replay book-meeting --run     # full pipeline in-process with the fake WhatsApp client
pnpm replay book-meeting --send    # signed POST to the running API
pnpm replay telegram-text --run    # Telegram fixtures work the same way
pnpm telegram me                   # check the bot token (also: set-webhook <url>, info, delete-webhook)
```

## CI and merging

`main` is protected: every change lands through a pull request, and the single
required check, **`gate`** (`.github/workflows/ci.yml`), must pass on a branch that is
up to date with `main`. Nobody can bypass it, admins included, and force pushes and
branch deletion are blocked.

`gate` looks at what the PR changes and requires the matching jobs to pass:

| Change | Required |
| --- | --- |
| Code | typecheck, migrations on an empty DB, schema-drift check, tests (incl. Postgres), build, and `pnpm smoke` (boots the compiled api + worker, sends real fixtures through both webhooks, checks the worker stored them, checks clean shutdown) |
| Agent, tools, policy, fixtures or dependencies | the above, plus live-model evals (no regression below `evals/baseline.json`, adversarial cases must pass) |
| Docs only | nothing |

Run the evals by hand from the Actions tab: "CI" → "Run workflow" → tick *evals*.

## Deploying

Production runs on Render from [`render.yaml`](render.yaml): api, worker, Postgres and
Key Value in Frankfurt, deployed from `main` only after CI passes. First deploy and
operations: [`docs/deploy-render.md`](docs/deploy-render.md).

## Connecting a real number

1. Follow `docs/whatsapp-notes.md` §2 (Meta app, WABA, system-user token).
2. Expose the API: `cloudflared tunnel --url http://localhost:3000`.
3. In the Meta dashboard set the callback URL to `https://<tunnel>/webhook`, set the
   verify token to `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.
4. Message the number from an allow-listed phone.
