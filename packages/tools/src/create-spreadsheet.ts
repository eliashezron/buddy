import { defineTool } from '@wa/core'
import { z } from 'zod'
import { googleApi } from './google-api.js'
import { trashFile } from './google-drive.js'

const createdSchema = z.object({ spreadsheetId: z.string(), spreadsheetUrl: z.string().optional() })

/**
 * Formula functions that fetch URLs. A formula built from untrusted text (an email, a web
 * page) could use them to send the sheet's data to someone else's server, so they are
 * stored as plain text instead.
 */
const NETWORK_FUNCTIONS = /\b(IMPORTXML|IMPORTHTML|IMPORTDATA|IMPORTFEED|IMPORTRANGE|IMAGE|WEBSERVICE|GOOGLEFINANCE)\s*\(/i
// No leading zeros (phone numbers like 0770123456 must keep theirs) and at most 15 digits
// (longer ids and account numbers would lose precision as numbers).
const NUMBER = /^-?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$/
const MAX_DIGITS = 15

type CellValue = { numberValue: number } | { formulaValue: string } | { stringValue: string }

/**
 * A cell for the values API with USER_ENTERED, which parses input like the Sheets UI does.
 * Network formulas and numbers that would lose digits are prefixed with ' so Sheets keeps
 * them as text; everything else is parsed as usual.
 */
export function userEnteredCell(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('=') && NETWORK_FUNCTIONS.test(s)) return `'${raw}`
  if (/^[+-]?\d[\d,.]*$/.test(s) && !(NUMBER.test(s) && s.replace(/\D/g, '').length <= MAX_DIGITS)) return `'${raw}`
  return raw
}

/** A cell as Sheets stores it: numbers as numbers, safe formulas as formulas, the rest as text. */
export function cellValue(raw: string): CellValue {
  const s = raw.trim()
  if (s.startsWith('=') && !NETWORK_FUNCTIONS.test(s)) return { formulaValue: s }
  if (NUMBER.test(s) && s.replace(/\D/g, '').length <= MAX_DIGITS) return { numberValue: Number(s.replaceAll(',', '')) }
  return { stringValue: raw }
}

export const createSpreadsheet = defineTool({
  name: 'create_spreadsheet',
  description:
    "Create a new Google Sheet in the user's Drive: a budget, a tracker, a list, a comparison table. Give " +
    'one or more tabs, each with rows of cells; the first row is the header (bold, frozen). Numbers are ' +
    'stored as numbers; formulas starting with = are kept (e.g. =SUM(B2:B10)), except ones that fetch from ' +
    'the web. Private to the user; not shared. Only when the user asked for it in their own message. Reply ' +
    'with the link. The user can undo for 10 minutes. Asks the user to connect Google Drive if needed.',
  risk: 'low_write',
  input: z.object({
    title: z.string().min(1).max(200),
    sheets: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          rows: z.array(z.array(z.string().max(2_000)).max(50)).min(1).max(1_000).describe('First row is the header'),
        }),
      )
      .min(1)
      .max(10),
  }),
  preview: ({ title, sheets }) => `Create a Google Sheet "${title}" (${sheets.length} tab${sheets.length === 1 ? '' : 's'})`,
  async execute({ title, sheets }, ctx) {
    const created = await googleApi(ctx, ['drive.create'], 'https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      schema: createdSchema,
      body: {
        properties: { title },
        sheets: sheets.map((sheet) => ({
          properties: { title: sheet.name, gridProperties: { frozenRowCount: sheet.rows.length > 1 ? 1 : 0 } },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: sheet.rows.map((row, i) => ({
                values: row.map((cell) => ({
                  userEnteredValue: cellValue(cell),
                  ...(i === 0 ? { userEnteredFormat: { textFormat: { bold: true } } } : {}),
                })),
              })),
            },
          ],
        })),
      },
    })
    return {
      ok: true as const,
      fileId: created.spreadsheetId,
      title,
      tabs: sheets.map((s) => s.name),
      link: created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
      sharedWithAnyone: false,
      undoableForMinutes: 10,
    }
  },
  async undo(result, ctx) {
    if (result.ok) await trashFile(ctx, result.fileId)
  },
})
