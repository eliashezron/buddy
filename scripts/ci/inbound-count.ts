/** Prints how many inbound messages on <channel> were stored since <iso date>. Used by smoke.sh. */
import { createDb } from '@wa/db'

const [channel, since] = process.argv.slice(2)
if (!channel || !since || !process.env.DATABASE_URL) throw new Error('usage: inbound-count <channel> <iso-date> (needs DATABASE_URL)')

const { db, close } = createDb(process.env.DATABASE_URL, { max: 1 })
try {
  const rows = await db.query.messages.findMany({
    where: (m, { and, eq, gte }) =>
      and(eq(m.channel, channel as 'whatsapp' | 'telegram'), eq(m.direction, 'inbound'), gte(m.createdAt, new Date(since))),
    columns: { id: true },
  })
  process.stdout.write(`${rows.length}\n`)
} finally {
  await close()
}
