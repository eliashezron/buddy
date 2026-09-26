# Daily brief

A short morning summary: today's calendar, important unread email from the last day, and
anything waiting on the user. Sent as text, or as a voice note for users in "voice" reply mode.

| Channel | Who gets it |
| --- | --- |
| Telegram | **On by default**. The brief ends with how to stop or move it. |
| WhatsApp | **Opt-in only** ("send me a morning brief"), and only while the 24 h customer service window is open. Outside it a free-form message needs an approved template, so that day is skipped. |

Everyone also needs **Google connected**: without it there is nothing to brief, so nothing is sent.

## Settings (by asking the bot → `set_daily_brief`)

- "stop the daily brief" / "start sending me a morning brief"
- "brief at 6:30" (local time, default 07:00)
- "I'm in Nairobi now" (IANA timezone, default Africa/Kampala)

Stored on `users`: `brief_enabled` (null = channel default), `brief_time`, `timezone`, `last_brief_on`.

## How it runs

```
maintenance queue, every 5 min ("brief-tick")
  → briefCandidates(): opted in, or Telegram and not opted out
  → briefDue(): local time ≥ brief_time, not sent today (local date), WhatsApp window open
  → inbound queue: { kind: 'brief', userId, date }  (job id = user + date: queued once a day)
worker (per-user lock, like messages)
  → still due? Google connected?
  → agent run with READ-ONLY tools (system-initiated: nothing in an email can make it act)
  → claimBrief(user, date): one conditional UPDATE, so a retry or racing tick can't send twice
  → send (text or voice), no connect links
```

Evals: `daily-brief` (reads calendar and email, no write tools), `brief-stop`, `brief-time`.

## Local test

Ask the dev bot "send my daily brief at HH:MM" with a time a minute or two from now (in
your timezone), then wait up to 5 minutes for the next tick.
