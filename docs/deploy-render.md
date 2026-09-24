# Deploying to Render

Everything is declared in [`render.yaml`](../render.yaml), a Render Blueprint:

| Resource | Type | Plan | Why |
| --- | --- | --- | --- |
| `buddy-api` | Web service | starter | Webhooks, `/health`. Not free: free web services sleep after 15 min and take ~1 min to wake, so webhook replies stall. |
| `buddy-worker` | Background worker | starter | Queue consumer and agent. Render has no free tier for workers. |
| `buddy-db` | Postgres 16 | basic-256mb | Free Postgres expires after 30 days. |
| `buddy-redis` | Key Value | starter | `noeviction` + journal persistence: queued messages survive restarts. Free Key Value doesn't persist. |

Everything runs in **Frankfurt**, the closest Render region to East Africa. The
database and Key Value accept internal connections only.

Check current prices on [render.com/pricing](https://render.com/pricing). At the time
of writing this setup is roughly $30/month.

## How deploys work

- **Only after CI passes.** `autoDeployTrigger: checksPass` means Render deploys a
  commit on `main` only once its GitHub checks (the `gate`) are green. Branch
  protection plus this means nothing reaches production without passing CI.
- **Migrations first.** Each service runs `node packages/db/dist/migrate.js` as its
  pre-deploy command. A Postgres advisory lock serialises them, so the first one
  applies pending migrations and the second finds none. Schema changes must stay
  backward compatible with the running code (add first, remove in a later deploy),
  because the old and new versions overlap briefly during a deploy.
- **Telegram registers itself.** On boot the api calls `setWebhook` with
  `RENDER_EXTERNAL_URL/telegram/webhook` and the secret. Nothing to do by hand.
- **Graceful shutdown.** Render sends SIGTERM and waits up to 30 s
  (`maxShutdownDelaySeconds`). The worker finishes active jobs within 15 s or hands
  them back to the queue.

## First deploy

1. In Render: **New → Blueprint**, connect GitHub and pick `eliashezron/buddy`
   (branch `main`). Render reads `render.yaml` and lists the four resources.
2. Fill in the secrets it asks for (they go into the `buddy-shared` environment group):

   | Variable | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | Your key (zero-retention terms) |
   | `TELEGRAM_BOT_TOKEN` | The **production** bot's token |
   | `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` |
   | `WHATSAPP_*` (4 values) | Real values once the Meta app exists. Until then any placeholder: the WhatsApp webhook then rejects everything. |

3. **Apply.** Render creates the database and Key Value, builds both services, runs
   migrations and starts them. Allow about 5–10 minutes.
4. Check it:
   ```sh
   curl https://buddy-api.onrender.com/health    # {"ok":true,...}; use your service's URL
   pnpm telegram info                            # url: https://…onrender.com/telegram/webhook, lastError: null
   ```
   Then message the bot.

## Local development after going live

**Use a separate bot for local development.** Create a second bot with @BotFather
(e.g. `@yourbot_dev_bot`) and put *its* token in your local `.env` with
`TELEGRAM_MODE=polling`.

Polling and webhooks are exclusive per bot. If you polled with the production token,
Telegram would stop delivering to Render. To prevent that by accident, local polling
refuses to start while the bot has a webhook registered, and logs why.
`TELEGRAM_POLLING_TAKEOVER=true` overrides this; only use it deliberately.

## WhatsApp, when the Meta app is ready

1. Replace the four `WHATSAPP_*` placeholders in the `buddy-shared` group and redeploy.
2. In the Meta app dashboard set the callback URL to
   `https://<buddy-api>.onrender.com/webhook` and the verify token to
   `WHATSAPP_VERIFY_TOKEN`, then subscribe to `messages`.

## Operations

- **Logs:** Render dashboard → service → Logs. JSON lines, with message bodies,
  tokens and phone numbers redacted.
- **Rollback:** service → Events → pick an earlier deploy → *Rollback*. Migrations
  don't roll back, which is another reason to keep schema changes backward compatible.
- **Rotate the Telegram secret:** change `TELEGRAM_WEBHOOK_SECRET` in the group and
  redeploy `buddy-api`; it re-registers the webhook with the new secret on boot.
- **Scale:** raise `numInstances` on the api freely. For more than one worker, first
  add the per-user Redis lock (see `docs/runbook.md`, known limitations).
