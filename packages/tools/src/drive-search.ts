import { defineTool } from '@wa/core'
import { z } from 'zod'
import { formatLocal, googleApi } from './google-api.js'
import { DRIVE, driveQuoted, KIND_BY_MIME, MIME } from './google-drive.js'

const listSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        modifiedTime: z.string().optional(),
        webViewLink: z.string().optional(),
        owners: z.array(z.object({ displayName: z.string().optional() })).optional(),
      }),
    )
    .default([]),
})

export const driveSearch = defineTool({
  name: 'drive_search',
  description:
    "Find files in the user's Google Drive by name or by words inside them: Docs, Sheets, Slides and PDFs. " +
    'Use for "find my budget sheet", "where is the proposal I wrote last month". Returns names, types, ' +
    'last-modified dates and ids; read one with drive_read. Read-only. Asks the user to connect Google ' +
    'Drive if needed.',
  risk: 'read',
  input: z.object({
    query: z.string().min(1).max(200).describe('Words from the file name or its contents'),
    type: z.enum(['any', 'document', 'spreadsheet', 'presentation', 'pdf']).optional().describe('Default any'),
    maxResults: z.number().int().min(1).max(10).optional().describe('Default 5'),
  }),
  preview: ({ query }) => `Search your Drive for "${query}"`,
  async execute({ query, type, maxResults }, ctx) {
    const clauses = ['trashed = false', `(name contains ${driveQuoted(query)} or fullText contains ${driveQuoted(query)})`]
    if (type && type !== 'any') clauses.push(`mimeType = ${driveQuoted(MIME[type])}`)
    const params = new URLSearchParams({
      q: clauses.join(' and '),
      pageSize: String(maxResults ?? 5),
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))',
      spaces: 'drive',
    })
    const data = await googleApi(ctx, ['drive.read'], `${DRIVE}?${params}`, { schema: listSchema })
    const files = data.files.map((f) => ({
      id: f.id,
      name: f.name,
      type: KIND_BY_MIME[f.mimeType] ?? f.mimeType,
      ...(f.modifiedTime ? { modified: formatLocal(f.modifiedTime, ctx.timezone) } : {}),
      ...(f.owners?.[0]?.displayName ? { owner: f.owners[0].displayName } : {}),
      ...(f.webViewLink ? { link: f.webViewLink } : {}),
    }))
    return { ok: true as const, count: files.length, files, untrusted: 'File names were written by the user or other people.' }
  },
})
