/**
 * Documents and images the user sends. The file is data, not instructions: the agent reads
 * and uses it, but nothing in it can make the agent act (CLAUDE.md).
 *
 * - `image` and `pdf` go to the model as they are (it reads the pixels / pages).
 * - `text` is the text we extracted (plain text, CSV, Word, Excel, PowerPoint).
 */
export type AttachmentKind = 'image' | 'pdf' | 'text'

export interface Attachment {
  /** Set once kept: how the model and tools refer to this file (e.g. to save it to Drive). */
  id?: string
  kind: AttachmentKind
  mimeType: string
  filename?: string
  /** image, pdf: the file itself. */
  data?: Uint8Array
  /** text: the extracted text. */
  text?: string
  /** text: extraction stopped at the size limit. */
  truncated?: boolean
}

/** Images and PDFs the model reads directly. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/** A kept file as the user sent it (before any conversion), for saving elsewhere. */
export interface OriginalFile {
  id: string
  filename?: string
  kind: AttachmentKind
  mimeType: string
  data: Uint8Array
}

/** The user's kept files. Only their own, and only until the files expire. */
export interface FileStore {
  originals(ids: string[]): Promise<OriginalFile[]>
}
