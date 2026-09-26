/**
 * pnpm replay <fixture> [--run | --send [url]]
 *
 *   (default)  Print the normalised payload: `_fixture` stripped, placeholders filled from env.
 *   --run      Run the full inbound pipeline in-process: signature check → parse → worker
 *              handler → agent, with the fake WhatsApp client. Needs Postgres and
 *              ANTHROPIC_API_KEY (or OPENCODE_API_KEY with LLM_PROVIDER=opencode).
 *              Prints what would have been sent. Nothing hits Graph.
 *   --send     POST the signed payload to a running API (default http://localhost:3000/webhook).
 *              The worker then sends real replies through the Cloud API.
 *
 * --run and --send rebase timestamps to now and suffix message ids, so repeated
 * replays aren't treated as redeliveries. Add --same-ids to test deduplication.
 *
 * Telegram fixtures (telegram-*.json) are detected automatically: --send posts to
 * /telegram/webhook with TELEGRAM_WEBHOOK_SECRET, --run uses the fake Telegram client.
 */
import { randomBytes } from 'node:crypto'
import { isTelegramUpdate, loadFixture, normaliseFixture, resolveFixture } from './lib/fixture.js'

const args = process.argv.slice(2)
const fixtureArg = args.find((a) => !a.startsWith('--'))
const mode = args.includes('--run') ? 'run' : args.includes('--send') ? 'send' : 'print'

if (!fixtureArg) {
  process.stderr.write('usage: pnpm replay <fixture> [--run | --send [url]] [--same-ids]\n')
  process.exit(2)
}

const file = resolveFixture(fixtureArg)
const live = mode !== 'print'
const payload = normaliseFixture(loadFixture(file), {
  env: process.env,
  ...(live ? { rebaseTo: new Date() } : {}),
  ...(live && !args.includes('--same-ids') ? { idSuffix: randomBytes(3).toString('hex') } : {}),
})
const raw = JSON.stringify(payload)
const telegram = isTelegramUpdate(payload)

if (mode === 'print') {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(0)
}

if (telegram && mode === 'send') {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) {
    process.stderr.write('TELEGRAM_WEBHOOK_SECRET is required to send a Telegram update\n')
    process.exit(1)
  }
  const idx = args.indexOf('--send')
  const next = args[idx + 1]
  const url = next && !next.startsWith('--') && next !== fixtureArg ? next : 'http://localhost:3000/telegram/webhook'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: raw,
  })
  process.stdout.write(`POST ${url} → ${res.status}\n`)
  process.exit(res.ok ? 0 : 1)
}

const { signBody, verifySignature } = await import('@wa/whatsapp')
const appSecret = process.env.WHATSAPP_APP_SECRET
if (!appSecret) {
  process.stderr.write('WHATSAPP_APP_SECRET is required to sign the replayed payload\n')
  process.exit(1)
}
const signature = signBody(raw, appSecret)

if (mode === 'send' && !telegram) {
  const idx = args.indexOf('--send')
  const next = args[idx + 1]
  const url = next && !next.startsWith('--') && next !== fixtureArg ? next : 'http://localhost:3000/webhook'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: raw,
  })
  process.stdout.write(`POST ${url} → ${res.status}\n`)
  process.exit(res.ok ? 0 : 1)
}

// --run: the same path the webhook + worker take, in one process.
const [{ default: Anthropic }, agent, core, db, tools, wa, tg, inbound] = await Promise.all([
  import('@anthropic-ai/sdk'),
  import('@wa/agent'),
  import('@wa/core'),
  import('@wa/db'),
  import('@wa/tools'),
  import('@wa/whatsapp'),
  import('@wa/telegram'),
  import('@wa/worker/inbound'),
])
const config = core.loadConfigOrExit(core.envSchema)
const logger = core.createLogger({ name: 'replay', level: config.LOG_LEVEL })
const tgBotId = config.TELEGRAM_BOT_TOKEN ? tg.botIdFromToken(config.TELEGRAM_BOT_TOKEN) : '0'

if (!telegram && !verifySignature(Buffer.from(raw), signature, config.WHATSAPP_APP_SECRET)) throw new Error('signature mismatch')
const { events, skipped } = telegram ? tg.parseTelegramUpdate(JSON.parse(raw), { botId: tgBotId }) : wa.parseWebhook(JSON.parse(raw))
logger.info({ events: events.length, skipped }, 'parsed')

const { db: database, close } = db.createDb(config.DATABASE_URL, { max: 2 })
const repo = db.createRepo(database)
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? 'unused-with-opencode' })
const opencode = config.LLM_PROVIDER === 'opencode' ? { apiKey: config.OPENCODE_API_KEY!, baseUrl: config.OPENCODE_BASE_URL } : null
const fake = new wa.FakeWhatsAppClient()
const fakeTg = new tg.FakeTelegramClient()
const handle = inbound.createInboundHandler({
  repo,
  channels: {
    whatsapp: wa.createWhatsAppChannel({ client: fake, getLastInboundAt: (waId) => repo.getLastInboundAt('whatsapp', waId) }),
    telegram: tg.createTelegramChannel({ client: fakeTg, botId: tgBotId }),
  },
  createMessage: opencode ? agent.createResponsesMessage(opencode) : (params, opts) => anthropic.beta.messages.create(params, opts),
  model: config.AGENT_MODEL,
  tools: tools.createTools({
    anthropic,
    searchModel: config.SEARCH_MODEL,
    ...(opencode ? { responsesSearch: { ...opencode, model: config.AGENT_MODEL } } : {}),
  }),
  logger,
  defaultTimezone: config.DEFAULT_TIMEZONE,
})

try {
  for (const event of events) await handle(event)
} finally {
  await close()
}

process.stdout.write('\n--- outbound (fake client, nothing sent) ---\n')
for (const call of [...fake.calls, ...fakeTg.calls]) process.stdout.write(`${JSON.stringify(call, null, 2)}\n`)
