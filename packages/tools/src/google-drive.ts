import type { ToolContext } from '@wa/core'
import { googleApi } from './google-api.js'

export const DRIVE = 'https://www.googleapis.com/drive/v3/files'

export const MIME = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  pdf: 'application/pdf',
} as const

export const KIND_BY_MIME: Record<string, string> = {
  [MIME.document]: 'Google Doc',
  [MIME.spreadsheet]: 'Google Sheet',
  [MIME.presentation]: 'Google Slides',
  [MIME.pdf]: 'PDF',
}

/** Accepts a file id or any Docs / Sheets / Slides / Drive link and returns the id. */
export function fileIdFrom(input: string): string | null {
  const s = input.trim()
  const fromPath = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s)
  if (fromPath) return fromPath[1]!
  const fromQuery = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s)
  if (fromQuery) return fromQuery[1]!
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null
}

/** Drive query strings quote with '…'; backslashes and quotes inside must be escaped. */
export const driveQuoted = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/**
 * Undo for the create tools: move the file to the Drive trash (recoverable for 30 days).
 * `drive.file` allows it because the app created the file. A file already gone is fine.
 */
export async function trashFile(ctx: ToolContext, fileId: string) {
  await googleApi(ctx, ['drive.create'], `${DRIVE}/${encodeURIComponent(fileId)}`, { method: 'PATCH', body: { trashed: true } }).catch(
    (err: unknown) => {
      if ((err as { status?: number }).status !== 404) throw err
    },
  )
}
