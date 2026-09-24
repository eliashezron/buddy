# Telegram Bot API — implementation notes

Telegram is the second channel (PRD D6: a channel-agnostic backend with Telegram as a
fallback). It uses the official Bot API only: no MTProto user clients, no userbots, and
no reading a user's own Telegram chats. The same rule applies as for WhatsApp: the bot
sees only messages sent *to it*.

## Ground rules

- **Official Bot API only** (`api.telegram.org`), via `packages/telegram`. Never call it
  from a route or a tool.
- **Private chats only.** Group, supergroup and channel messages are skipped at parse
  time, even if someone adds the bot to a group.
- **Webhook security:** Telegram doesn't sign requests. It echoes the `secret_token` we
  pass to `setWebhook` in `X-Telegram-Bot-Api-Secret-Token`. That header is checked with
  a timing-safe compare before the body is used. Respond 200 fast, enqueue, and
  process asynchronously, as with WhatsApp.
- **The bot token is in every API URL.** Never log URLs. The logger also redacts
  anything shaped like a bot token.
- **Same data rules:** no training on message content, the same retention, and
  forwarded messages are untrusted content.

## Setup

1. Message [@BotFather](https://t.me/BotFather): `/newbot`, then pick a name and username.
   Copy the token.
2. Optional, in BotFather: `/setdescription`, `/setuserpic`, and `/setcommands` with
   `start - Get started` and `help - What I can do`.
3. In `.env`: `TELEGRAM_BOT_TOKEN=<token>`, then check it with `pnpm telegram me`.

### Local development: polling (no tunnel)

```
TELEGRAM_MODE=polling
```

The api long-polls `getUpdates` and enqueues updates exactly like the webhook. Polling
deletes any registered webhook first, because Telegram refuses `getUpdates` while one is set.

Use a **separate dev bot** for local work once production exists: polling refuses to
start while the bot has a webhook registered, so it can't silently take the production
bot away (override with `TELEGRAM_POLLING_TAKEOVER=true`).

### Production: webhook

```
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
PUBLIC_BASE_URL=https://<public-host>            # the api registers the webhook on boot
                                                 # (on Render: automatic via RENDER_EXTERNAL_URL)
pnpm telegram set-webhook https://<public-host>   # manual alternative
pnpm telegram info                               # pending updates, last delivery error
```

Telegram only accepts HTTPS on ports 443, 80, 88 or 8443.

## Behaviour

| Topic | Telegram | WhatsApp, for comparison |
| --- | --- | --- |
| Reply window | None: a bot can reply any time after the user starts it | 24 h service window, templates outside it |
| Message id | `message_id` is per chat; we store `<chatId>:<message_id>` | `wamid` is globally unique |
| Dedup | Job id and a DB unique key on `(channel, external_message_id)` | Same |
| Typing | `sendChatAction typing` lasts ~5 s, refreshed every 4.5 s until the reply | One `typing_indicator` call with the read receipt |
| Formatting | HTML parse mode (`b`, `i`, `s`, `code`, `a`); all other text escaped; plain-text fallback if Telegram rejects the markup | `*bold*`, `_italic_`, `~strike~` |
| Length | 4096 chars per message; we split at 3800 | 4096; we split at 4000 |
| Commands | `/start` and `/help` get a fixed welcome; other commands with arguments go to the agent | n/a |
| Delivery receipts | None | `statuses[]` webhooks |

## Errors

| Code | Meaning | Handling |
| --- | --- | --- |
| 400 `can't parse entities` | Our HTML was rejected | Resend that chunk as plain text |
| 403 `bot was blocked by the user` | User blocked the bot | Permanent: log and drop |
| 429 | Flood control | Wait `parameters.retry_after`, then retry |
| 5xx / network | Telegram-side problem | Retry with backoff; the queue retries the job |

## Not yet

- Voice notes, photos and documents get the same "not yet" reply as on WhatsApp.
  Files come from `getFile` + `https://api.telegram.org/file/bot<token>/<path>` (limit 20 MB).
- Inline keyboards (`callback_query`) for approvals, the Telegram equivalent of
  WhatsApp's reply buttons.
- Linking one person's Telegram and WhatsApp accounts. Today they are separate users.
