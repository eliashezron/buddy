import { IMAGE_TYPES, type Attachment, type MediaFile } from '@wa/core'
import { heicToJpeg } from './heic.js'
import { docxText, OfficeFileError, pptxText, xlsxText } from './office.js'

/**
 * Turns a file the user sent into something the model can read: images and PDFs as they are,
 * everything else we support as extracted text. Kept in memory; the caller stores the result
 * for a few hours so follow-up messages can refer to it.
 */

/** Images: the model APIs' own per-image limit. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** PDFs and other documents. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
/** ~25k tokens of extracted text; longer files are cut, and the model is told. */
export const MAX_TEXT_CHARS = 100_000

export type FileFormat = 'image' | 'heic' | 'pdf' | 'text' | 'docx' | 'xlsx' | 'pptx'

export class UnsupportedFileError extends Error {
  override name = 'UnsupportedFileError'
  constructor(
    message: string,
    readonly reason: 'type' | 'unreadable' | 'empty',
  ) {
    super(message)
  }
}

const OOXML = 'application/vnd.openxmlformats-officedocument'
const BY_MIME: Record<string, FileFormat> = {
  'application/pdf': 'pdf',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/heic-sequence': 'heic',
  'image/heif-sequence': 'heic',
  [`${OOXML}.wordprocessingml.document`]: 'docx',
  [`${OOXML}.spreadsheetml.sheet`]: 'xlsx',
  [`${OOXML}.presentationml.presentation`]: 'pptx',
  'application/json': 'text',
  'application/xml': 'text',
  'application/x-yaml': 'text',
}
const BY_EXTENSION: Record<string, FileFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  txt: 'text',
  csv: 'text',
  tsv: 'text',
  md: 'text',
  json: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  log: 'text',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  heic: 'heic',
  heif: 'heic',
}
const EXTENSION_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

const extensionOf = (filename?: string) => /\.([a-z0-9]+)$/i.exec(filename ?? '')?.[1]?.toLowerCase()
/** "image/jpeg; charset=…" → "image/jpeg". */
const baseMime = (mime?: string) => mime?.split(';')[0]?.trim().toLowerCase() ?? ''

/** What we can do with a file, from its MIME type or, failing that (octet-stream), its extension. */
export function fileFormat(mimeType: string | undefined, filename?: string): FileFormat | null {
  const mime = baseMime(mimeType)
  if ((IMAGE_TYPES as readonly string[]).includes(mime)) return 'image'
  if (BY_MIME[mime]) return BY_MIME[mime]
  if (mime.startsWith('text/') && mime !== 'text/html') return 'text'
  const ext = extensionOf(filename)
  return (ext && BY_EXTENSION[ext]) || null
}

/** HEIC is converted to a smaller JPEG first, so it may be larger than a photo sent as is. */
export function maxBytesFor(format: FileFormat): number {
  return format === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
}

function decodeText(data: Uint8Array): string {
  // Binary files renamed .txt: refuse rather than send noise.
  const sample = data.subarray(0, 4096)
  if (sample.includes(0)) throw new UnsupportedFileError('file is binary', 'unreadable')
  return new TextDecoder('utf-8').decode(data).replace(/^﻿/, '')
}

function textAttachment(mimeType: string, filename: string | undefined, text: string): Attachment {
  const trimmed = text.trim()
  if (!trimmed) throw new UnsupportedFileError('no text in file', 'empty')
  const truncated = trimmed.length > MAX_TEXT_CHARS
  return {
    kind: 'text',
    mimeType,
    ...(filename ? { filename } : {}),
    text: truncated ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed,
    ...(truncated ? { truncated: true } : {}),
  }
}

/** The file → an attachment for the model. Throws UnsupportedFileError when we can't read it. */
export async function toAttachment(file: MediaFile, opts: { filename?: string } = {}): Promise<Attachment> {
  const { filename } = opts
  const format = fileFormat(file.mimeType, filename)
  if (!format) throw new UnsupportedFileError(`unsupported type ${baseMime(file.mimeType) || 'unknown'}`, 'type')
  if (!file.data.length) throw new UnsupportedFileError('empty file', 'empty')
  const mime = baseMime(file.mimeType)
  const named = filename ? { filename } : {}
  if (format === 'image') {
    const imageMime = (IMAGE_TYPES as readonly string[]).includes(mime) ? mime : EXTENSION_MIME[extensionOf(filename) ?? ''] ?? 'image/jpeg'
    return { kind: 'image', mimeType: imageMime, data: file.data, ...named }
  }
  if (format === 'heic') {
    let jpeg: Uint8Array
    try {
      jpeg = await heicToJpeg(file.data)
    } catch {
      throw new UnsupportedFileError('not a readable HEIC image', 'unreadable')
    }
    return { kind: 'image', mimeType: 'image/jpeg', data: jpeg, ...named }
  }
  if (format === 'pdf') {
    // "%PDF" within the first KB, as readers allow; otherwise the provider would reject it.
    if (!new TextDecoder('latin1').decode(file.data.subarray(0, 1024)).includes('%PDF')) throw new UnsupportedFileError('not a PDF', 'unreadable')
    return { kind: 'pdf', mimeType: 'application/pdf', data: file.data, ...named }
  }
  try {
    const text =
      format === 'docx' ? docxText(file.data) : format === 'xlsx' ? xlsxText(file.data) : format === 'pptx' ? pptxText(file.data) : decodeText(file.data)
    return textAttachment(mime || 'text/plain', filename, text)
  } catch (err) {
    if (err instanceof OfficeFileError) throw new UnsupportedFileError(err.message, 'unreadable')
    throw err
  }
}
