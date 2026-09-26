import type { InboundMessage } from '@wa/core'

/**
 * Photos and documents the user sends. Each is read once when it arrives (packages/files),
 * kept for a few hours so follow-ups can refer to it, then deleted by the maintenance job.
 */

/** How long a file stays available to later messages. */
export const ATTACHMENT_TTL_MS = 3 * 60 * 60_000
/**
 * Photos sent together arrive as separate messages. Each waits this long before it is
 * answered; if another message came in meanwhile, only the last one is answered, with all
 * the files in view.
 */
export const ATTACHMENT_SETTLE_MS = 2_500
/** Files shown to the model per request, newest first, within a size budget. */
export const MAX_ATTACHMENTS_IN_CONTEXT = 4
/** Stays well under the model APIs' request size limits once base64-encoded. */
export const ATTACHMENT_CONTEXT_BYTES = 15 * 1024 * 1024

export const FILE_REPLIES = {
  type: "I can't open that kind of file yet. I can read photos (including iPhone HEIC), PDFs, Word, Excel and PowerPoint files, and text or CSV files.",
  imageTooLarge: 'That photo is over 5 MB, which is more than I can take. Could you send a smaller one?',
  documentTooLarge: 'That file is over 10 MB, which is more than I can take. Could you send a smaller one, or just the pages you need?',
  unreadable: "I couldn't open that file. It may be damaged or password-protected. Could you send another copy, or a PDF?",
  empty: "That file looks empty to me. Could you check it and send it again?",
  failed: 'Sorry, I had trouble downloading that file. Please try again in a moment.',
} as const

export const isFileMessage = (m: InboundMessage) => (m.type === 'image' || m.type === 'document') && Boolean(m.media)

/**
 * Which kept files go to the model: newest first, at most MAX_ATTACHMENTS_IN_CONTEXT and
 * ATTACHMENT_CONTEXT_BYTES. The current message's file always goes.
 */
export function pickAttachments(candidates: { id: string; sizeBytes: number }[], currentId: string | null): Set<string> {
  const picked = new Set<string>()
  let bytes = 0
  const current = currentId ? candidates.find((c) => c.id === currentId) : undefined
  if (current) {
    picked.add(current.id)
    bytes += current.sizeBytes
  }
  for (const c of [...candidates].reverse()) {
    if (picked.size >= MAX_ATTACHMENTS_IN_CONTEXT) break
    if (picked.has(c.id) || bytes + c.sizeBytes > ATTACHMENT_CONTEXT_BYTES) continue
    picked.add(c.id)
    bytes += c.sizeBytes
  }
  return picked
}
