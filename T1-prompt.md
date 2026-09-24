# T1 handoff prompt

Paste this into Claude Code in an empty repo that already contains `CLAUDE.md`,
`docs/PRD.md`, `docs/whatsapp-notes.md` and `fixtures/`.

---

Read `CLAUDE.md` and `docs/PRD.md` first.

Implement **T1: repo scaffold**. Scope is the skeleton only — no WhatsApp logic, no
agent, no tools. Those are T2 and T4.

Build:

1. A pnpm workspace with `apps/api`, `apps/worker`, `apps/web`, and `packages/core`,
   `packages/db`, `packages/whatsapp`, `packages/agent`, `packages/tools`. Empty
   packages get an index file and a passing placeholder test.
2. TypeScript strict across the workspace, one shared `tsconfig.base.json`.
3. `apps/api` on Fastify with `GET /health` returning `{ ok: true, version }`.
   Register a raw-body hook scoped to `/webhook` only (T2 will use it), and leave the
   route itself unimplemented with a clear TODO.
4. `packages/core/config.ts`: env parsing with zod. Required vars — `DATABASE_URL`,
   `REDIS_URL`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `GRAPH_API_VERSION`, `ANTHROPIC_API_KEY`.
   Boot must fail with a readable message listing every missing variable. Include a
   `.env.example`.
5. `packages/core/logger.ts`: structured logging with redaction of message bodies,
   transcripts, tokens, and phone numbers masked to the last 4 digits.
6. `docker-compose.yml` with Postgres 16 and Redis 7, plus `packages/db` wired to
   Drizzle with an empty initial migration and `pnpm db:migrate`.
7. `apps/worker` with a BullMQ connection and one no-op `inbound` queue consumer that
   logs and exits cleanly on SIGTERM.
8. Scripts at the root: `dev`, `build`, `test`, `typecheck`, `evals` (placeholder that
   exits 0), `db:migrate`, `replay`. `pnpm replay <fixture>` should load a file from
   `fixtures/`, strip the `_fixture` key, and for now just print the normalised
   payload — T3 will make it run the pipeline.
9. GitHub Actions CI running typecheck, test and build on every PR.

Acceptance criteria:

- `docker compose up -d && pnpm install && pnpm db:migrate && pnpm dev` starts the API
  and worker with no errors.
- `curl localhost:3000/health` returns 200.
- Removing any required env var makes boot fail with a message naming it.
- `pnpm replay fixtures/book-meeting.json` prints the payload without crashing.
- `pnpm test` and `pnpm typecheck` pass; CI is green.

Do not add any dependency on an unofficial WhatsApp library. When you are done, list
what T2 will need to change in `apps/api`.
