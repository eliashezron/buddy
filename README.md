# WhatsApp assistant

A task assistant people reach on a WhatsApp Business number (official Cloud API only).
Right now it answers questions by searching the web and reading pages. Calendar,
email, Notion and payments come next. Scope: `docs/PRD.md`. Rules: `CLAUDE.md`.
Platform notes: `docs/whatsapp-notes.md`.

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

## How a message flows

```
WhatsApp → POST /webhook (apps/api)
  verify X-Hub-Signature-256 over the raw body → parse every entry/change/message
  → enqueue (job id = WhatsApp id, so redeliveries dedupe) → 200 in a few ms
→ inbound queue (apps/worker)
  upsert user, store message (unique wa_message_id), mark read + typing
  → agent loop (packages/agent): Claude + tools; every tool call gets an
    `actions` row before it runs; outbound/money tools are gated by the policy
  → reply through the 24 h-window-guarded sender (packages/whatsapp)
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
```

## Connecting a real number

1. Follow `docs/whatsapp-notes.md` §2 (Meta app, WABA, system-user token).
2. Expose the API: `cloudflared tunnel --url http://localhost:3000`.
3. In the Meta dashboard set the callback URL to `https://<tunnel>/webhook`, set the
   verify token to `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.
4. Message the number from an allow-listed phone.
