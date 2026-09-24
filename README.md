# WhatsApp assistant

A task assistant people reach on a WhatsApp Business number (official Cloud API only)
or a Telegram bot (official Bot API).
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

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every PR and push
to `main`, skipping docs-only changes. Evals call the live model, so they run in
their own workflow (`evals.yml`), only on ready PRs that touch the agent, tools,
policy, fixtures or dependencies, or when triggered by hand from the Actions tab.

## Connecting a real number

1. Follow `docs/whatsapp-notes.md` §2 (Meta app, WABA, system-user token).
2. Expose the API: `cloudflared tunnel --url http://localhost:3000`.
3. In the Meta dashboard set the callback URL to `https://<tunnel>/webhook`, set the
   verify token to `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.
4. Message the number from an allow-listed phone.
