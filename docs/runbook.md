# Runbook

## Failure modes

## Known limitations

Current gaps in the v0 build (web lookup only). Each has a planned fix.

- **Concurrent messages from one user.** The worker serialises each user's messages
  in-process (`apps/worker/src/lock.ts`). With more than one worker process, two quick
  messages from the same user can run concurrently and miss each other's context.
  Fix before scaling out: a Redis lock per `wa_id`, or BullMQ group keys.
- **Replies outside the 24 h window are dropped** (logged as
  `reply dropped: service window closed`). There are no approved templates yet.
- **Retries re-run the whole agent turn.** Safe today because every tool is `read`.
  Before the first `low_write`/`outbound` tool ships, retries must resume from the
  `actions` rows instead of re-executing.
- **Voice notes, images, documents** get a polite "not yet" reply (F2 pending), on both
  WhatsApp and Telegram.
- **Telegram and WhatsApp accounts aren't linked.** The same person on both channels is
  two users, with separate history.
- **Telegram polling mode is for one api instance.** Two pollers on one bot token
  compete for updates. Use webhook mode in production.
- **OAuth tokens use a local AES key, not KMS** (CLAUDE.md requires KMS). This must be
  resolved before real users connect Google accounts in production; see `docs/connectors.md`.
- **Google app is in Testing mode:** up to 100 test users, and refresh tokens expire after
  about a week (users are asked to reconnect).
- **Per-user ordering across a connect/resume:** chat messages lock per `channel:id` and
  resume events per user id, so a message sent at the exact moment of a resume can run
  concurrently with it.
- **Approval flow** is not built. `outbound`/`money` tool calls are recorded as
  `cancelled` and never executed (`packages/agent/src/loop.ts`).
- **Web search goes through Anthropic's server-side tool**, via a Claude sub-call
  (`packages/tools/src/web-search.ts`). Confirm this is covered by our zero-retention
  terms before launch.
