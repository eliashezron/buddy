import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger, type InboundMessage } from '@wa/core'
import { createTelegramChannel } from '../src/channel.js'
import { BotApiClient, FakeTelegramClient, TelegramApiError } from '../src/client.js'
import { toPlainText, toTelegramHtml } from '../src/format.js'
import { botIdFromToken, InvalidUpdateError, parseTelegramUpdate as parseWithBot } from '../src/parse.js'
import { verifySecretToken } from '../src/secret.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures')
function fixture(name: string): Record<string, any> {
  const { _fixture: _meta, ...payload } = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'))
  return payload
}
const telegramFixtures = readdirSync(FIXTURES)
  .filter((f) => f.startsWith('telegram-'))
  .map((f) => f.replace(/\.json$/, ''))
const logger = createLogger({ name: 'test', level: 'silent' })
const BOT_ID = '7000000001'
const parseTelegramUpdate = (json: unknown) => parseWithBot(json, { botId: BOT_ID })

describe('parseTelegramUpdate', () => {
  it.each(telegramFixtures)('parses fixture %s', (name) => {
    expect(() => parseTelegramUpdate(fixture(name))).not.toThrow()
  })

  it('normalises a private text message with a bot- and chat-scoped id', () => {
    expect(parseTelegramUpdate(fixture('telegram-text'))).toEqual({
      updateId: 900000001,
      skipped: [],
      events: [
        {
          kind: 'message',
          message: {
            channel: 'telegram',
            id: '7000000001:555000111:41',
            from: '555000111',
            timestamp: 1790000500,
            type: 'text',
            platformMessageId: '41',
            contactName: 'Elias',
            text: "what's the dollar rate in UGX today?",
          },
        },
      ],
    })
  })

  it('keys the same chat and message_id differently per bot', () => {
    // A private chat's id is the user's id for every bot, and message_id restarts per bot.
    const a = parseWithBot(fixture('telegram-text'), { botId: '1' }).events[0]
    const b = parseWithBot(fixture('telegram-text'), { botId: '2' }).events[0]
    expect(a?.kind === 'message' && b?.kind === 'message' && a.message.id !== b.message.id).toBe(true)
  })

  it('takes the bot id from the token', () => {
    expect(botIdFromToken('7000000001:AAH-secret')).toBe('7000000001')
    expect(() => botIdFromToken('not-a-token')).toThrow()
  })

  it('parses bot commands, including /cmd@BotName and arguments', () => {
    const start = parseTelegramUpdate(fixture('telegram-start')).events[0]
    expect(start?.kind === 'message' && start.message).toMatchObject({ type: 'command', command: 'start', text: '' })

    const withArgs = fixture('telegram-start')
    withArgs.message.text = '/Search@BuddyBot usd rate'
    withArgs.message.entities = [{ offset: 0, length: 16, type: 'bot_command' }]
    const e = parseTelegramUpdate(withArgs).events[0]
    expect(e?.kind === 'message' && e.message).toMatchObject({ type: 'command', command: 'search', text: 'usd rate' })
  })

  it('flags forwarded messages and maps voice notes to audio', () => {
    const fwd = parseTelegramUpdate(fixture('telegram-forwarded')).events[0]
    expect(fwd?.kind === 'message' && fwd.message.forwarded).toBe(true)
    const voice = parseTelegramUpdate(fixture('telegram-voice')).events[0]
    expect(voice?.kind === 'message' && voice.message).toMatchObject({
      type: 'audio',
      media: { kind: 'audio', id: 'TG_FILE_ID_PLACEHOLDER', mimeType: 'audio/ogg', voice: true },
    })
  })

  it('takes the largest photo size', () => {
    const u = fixture('telegram-text')
    delete u.message.text
    u.message.photo = [{ file_id: 'small' }, { file_id: 'large' }]
    u.message.caption = 'menu'
    const e = parseTelegramUpdate(u).events[0]
    expect(e?.kind === 'message' && e.message.media).toEqual({ kind: 'image', id: 'large', caption: 'menu' })
  })

  it('never reads groups, and ignores other bots and other update types', () => {
    expect(parseTelegramUpdate(fixture('telegram-group'))).toMatchObject({ events: [], skipped: [{ reason: 'non-private chat' }] })
    const bot = fixture('telegram-text')
    bot.message.from.is_bot = true
    expect(parseTelegramUpdate(bot).skipped).toEqual([{ field: 'message', reason: 'sent by a bot' }])
    expect(parseTelegramUpdate({ update_id: 1, edited_message: {} }).skipped).toEqual([
      { field: 'edited_message', reason: 'unhandled update type' },
    ])
  })

  it('rejects things that are not updates', () => {
    expect(() => parseTelegramUpdate({ object: 'whatsapp_business_account' })).toThrow(InvalidUpdateError)
  })
})

describe('parseTelegramUpdate: button presses', () => {
  const ACTION = '0b6f6c55-3a1e-4d1f-9c55-2d1c1f5c9e11'
  const cb = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    update_id: 5,
    callback_query: {
      id: '4382bfdwdsb323b2d9',
      from: { id: 555000111, is_bot: false, first_name: 'Elias' },
      message: { message_id: 42, date: 1790000000, chat: { id: 555000111, type: 'private' }, ...message },
      data: `approve:${ACTION}`,
      ...over,
    },
  })

  it('turns a press in the user\'s own chat into a button message carrying the payload and callback id', () => {
    const e = parseWithBot(cb(), { botId: BOT_ID }).events[0]
    expect(e).toMatchObject({
      kind: 'message',
      message: {
        channel: 'telegram',
        id: `${BOT_ID}:555000111:cb:4382bfdwdsb323b2d9`,
        from: '555000111',
        type: 'button',
        platformMessageId: '42',
        reply: { id: `approve:${ACTION}` },
        callbackId: '4382bfdwdsb323b2d9',
      },
    })
  })

  it('ignores presses from anyone but the chat owner, in groups, by bots, or without data', () => {
    const skipped = (u: unknown) => parseWithBot(u, { botId: BOT_ID })
    expect(skipped(cb({ from: { id: 999, is_bot: false, first_name: 'M' } }))).toMatchObject({ events: [], skipped: [{ reason: 'not from the chat owner' }] })
    expect(skipped(cb({}, { chat: { id: 555000111, type: 'group' } })).events).toEqual([])
    expect(skipped(cb({ from: { id: 555000111, is_bot: true, first_name: 'B' } })).events).toEqual([])
    expect(skipped(cb({ data: undefined })).skipped).toEqual([{ field: 'callback_query', reason: 'malformed callback query' }])
  })
})

describe('toTelegramHtml', () => {
  it('converts the agent Markdown subset', () => {
    expect(toTelegramHtml('## Options\n**Kololo Hall** holds _20_.\n- [Site](https://example.com/a?b=1&c=2)\n- ~~old~~ `code`')).toBe(
      '<b>Options</b>\n<b>Kololo Hall</b> holds <i>20</i>.\n• <a href="https://example.com/a?b=1&amp;c=2">Site</a>\n• <s>old</s> <code>code</code>',
    )
  })

  it('escapes everything else, so text from the web cannot inject markup', () => {
    expect(toTelegramHtml('<script>x</script> & <b>not bold</b>')).toBe('&lt;script&gt;x&lt;/script&gt; &amp; &lt;b&gt;not bold&lt;/b&gt;')
    expect(toTelegramHtml('[x](https://e.com/"><b>)')).toBe('<a href="https://e.com/&quot;&gt;&lt;b&gt;">x</a>')
  })

  it('leaves snake_case and bare URLs alone', () => {
    expect(toTelegramHtml('set max_retry_count at https://e.com/a_b_c')).toBe('set max_retry_count at https://e.com/a_b_c')
  })

  it('has a plain-text fallback', () => {
    expect(toPlainText('**Hi** [site](https://e.com)')).toBe('Hi site: https://e.com')
  })
})

describe('Telegram channel', () => {
  afterEach(() => vi.useRealTimers())
  const msg = { channel: 'telegram', id: '1:2', from: '1', timestamp: 1, type: 'text', platformMessageId: '2' } satisfies InboundMessage

  it('sends HTML and returns bot- and chat-scoped ids', async () => {
    const client = new FakeTelegramClient()
    const ch = createTelegramChannel({ client, botId: '9' })
    expect(await ch.sendText('555', '**hi**')).toEqual(['9:555:1'])
    expect(client.sent).toEqual([{ method: 'sendMessage', chatId: '555', text: '<b>hi</b>', html: true }])
  })

  it('splits long replies into several messages', async () => {
    const client = new FakeTelegramClient()
    const ids = await createTelegramChannel({ client, botId: '9' }).sendText('555', `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`)
    expect(ids).toEqual(['9:555:1', '9:555:2'])
  })

  it('falls back to plain text when Telegram rejects the markup', async () => {
    const client = new FakeTelegramClient()
    client.failNextHtml = true
    await createTelegramChannel({ client, botId: '9' }).sendText('555', '**hi**')
    expect(client.sent).toEqual([{ method: 'sendMessage', chatId: '555', text: 'hi', html: false }])
  })

  it('keeps "typing…" alive until stopped', async () => {
    vi.useFakeTimers()
    const client = new FakeTelegramClient()
    const stop = createTelegramChannel({ client, botId: '9' }).startTyping(msg)
    await vi.advanceTimersByTimeAsync(10_000)
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.calls.filter((c) => c.method === 'sendChatAction')).toHaveLength(3)
  })
})

describe('Telegram approval cards', () => {
  const ACTION = '0b6f6c55-3a1e-4d1f-9c55-2d1c1f5c9e11'
  const card = (preview: string) => ({ actionId: ACTION, preview, title: 'Email to kato@example.com', approveLabel: 'Send' })

  it('puts the preview and Send / Cancel buttons in one message', async () => {
    const client = new FakeTelegramClient()
    const ids = await createTelegramChannel({ client, botId: '9' }).sendApproval('555', card('**Send this?**\nTo: kato@example.com'))
    expect(ids).toEqual(['9:555:1'])
    expect(client.sent).toEqual([
      {
        method: 'sendMessage',
        chatId: '555',
        text: '<b>Send this?</b>\nTo: kato@example.com',
        html: true,
        buttons: [[{ text: '✅ Send', data: `approve:${ACTION}` }, { text: '✖ Cancel', data: `cancel:${ACTION}` }]],
      },
    ])
  })

  it('sends a long preview in full first, then a short card with the buttons', async () => {
    const client = new FakeTelegramClient()
    await createTelegramChannel({ client, botId: '9' }).sendApproval('555', card(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`))
    expect(client.sent.map((m) => Boolean(m.buttons))).toEqual([false, false, true])
    expect(client.sent.at(-1)!.text).toContain('approve the message above?')
  })

  it('closes a card: answers the press and removes the buttons, ignoring failures', async () => {
    const client = new FakeTelegramClient()
    client.removeButtons = async () => {
      throw new TelegramApiError(400, 'Bad Request: message is not modified')
    }
    const pressed = { channel: 'telegram', id: 'x', from: '555', timestamp: 1, type: 'button', platformMessageId: '42', callbackId: 'cb' } satisfies InboundMessage
    await expect(createTelegramChannel({ client, botId: '9' }).closeApproval(pressed, 'Cancelled')).resolves.toBeUndefined()
    expect(client.calls).toEqual([{ method: 'answerCallbackQuery', callbackId: 'cb', text: 'Cancelled' }])
  })
})

describe('BotApiClient', () => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'
  function fakeFetch(responses: { status: number; body: unknown }[]) {
    const calls: { url: string; body: unknown }[] = []
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      const r = responses.shift()!
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('calls sendMessage with HTML parse mode and no link previews', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, result: { message_id: 77 } } }])
    const client = new BotApiClient({ token, logger, fetch: f.impl })
    await expect(client.sendMessage('555', '<b>x</b>', { html: true })).resolves.toEqual({ messageId: '77' })
    expect(f.calls[0]!.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`)
    expect(f.calls[0]!.body).toEqual({ chat_id: '555', text: '<b>x</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  })

  it('sends inline keyboards and subscribes to button presses', async () => {
    const f = fakeFetch([
      { status: 200, body: { ok: true, result: { message_id: 78 } } },
      { status: 200, body: { ok: true, result: [] } },
      { status: 200, body: { ok: true, result: true } },
    ])
    const client = new BotApiClient({ token, logger, fetch: f.impl })
    await client.sendMessage('555', 'Send?', { buttons: [[{ text: 'Send', data: 'approve:x' }]] })
    expect(f.calls[0]!.body).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'Send', callback_data: 'approve:x' }]] } })
    await client.getUpdates(0, 0)
    expect(f.calls[1]!.body).toMatchObject({ allowed_updates: ['message', 'callback_query'] })
    await client.setWebhook('https://x/telegram/webhook', 'secret')
    expect(f.calls[2]!.body).toMatchObject({ allowed_updates: ['message', 'callback_query'] })
  })

  it('honours retry_after on 429, then succeeds', async () => {
    const f = fakeFetch([
      { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0.01 } } },
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    ])
    const client = new BotApiClient({ token, logger, fetch: f.impl })
    await expect(client.sendMessage('555', 'x')).resolves.toEqual({ messageId: '1' })
    expect(f.calls).toHaveLength(2)
  })

  it('treats 403 (blocked by user) as permanent, and keeps the token out of the error', async () => {
    const f = fakeFetch([{ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }])
    const client = new BotApiClient({ token, logger, fetch: f.impl })
    const err = await client.sendMessage('555', 'x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect((err as TelegramApiError).permanent).toBe(true)
    expect(String((err as Error).message)).not.toContain(token)
    expect(f.calls).toHaveLength(1)
  })
})

describe('verifySecretToken', () => {
  it('accepts only the exact secret', () => {
    expect(verifySecretToken('s3cret-value', 's3cret-value')).toBe(true)
    expect(verifySecretToken('s3cret-valuX', 's3cret-value')).toBe(false)
    expect(verifySecretToken(undefined, 's3cret-value')).toBe(false)
    expect(verifySecretToken(['s3cret-value'], 's3cret-value')).toBe(false)
    expect(verifySecretToken('', '')).toBe(false)
  })
})
