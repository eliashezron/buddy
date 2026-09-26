/**
 * Documents and images the user sends. The file is data, not instructions: the agent reads
 * and uses it, but nothing in it can make the agent act (CLAUDE.md).
 *
 * - `image` and `pdf` go to the model as they are (it reads the pixels / pages).
 * - `text` is the text we extracted (plain text, CSV, Word, Excel, PowerPoint).
 */
export type AttachmentKind = 'image' | 'pdf' | 'text'

export interface Attachment {
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
