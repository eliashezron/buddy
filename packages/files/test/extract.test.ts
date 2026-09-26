import { readFileSync } from 'node:fs'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import jpeg from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { downscale, fileFormat, MAX_TEXT_CHARS, toAttachment, UnsupportedFileError } from '../src/index.js'

const OOXML = 'application/vnd.openxmlformats-officedocument'
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
const utf8 = (s: string) => new TextEncoder().encode(s)

describe('fileFormat', () => {
  it('uses the MIME type, then the extension', async () => {
    expect(fileFormat('image/jpeg')).toBe('image')
    expect(fileFormat('application/pdf')).toBe('pdf')
    expect(fileFormat('text/csv; charset=utf-8')).toBe('text')
    expect(fileFormat(`${OOXML}.spreadsheetml.sheet`)).toBe('xlsx')
    expect(fileFormat('application/octet-stream', 'Budget.XLSX')).toBe('xlsx')
    expect(fileFormat(undefined, 'scan.png')).toBe('image')
    expect(fileFormat('image/heic')).toBe('heic')
    expect(fileFormat('application/octet-stream', 'IMG_0001.HEIC')).toBe('heic')
  })

  it('refuses what we cannot read', async () => {
    expect(fileFormat('application/zip', 'photos.zip')).toBeNull()
    expect(fileFormat('application/msword', 'old.doc')).toBeNull()
    expect(fileFormat('text/html', 'page.html')).toBeNull()
  })
})

describe('toAttachment', () => {
  it('passes images and PDFs through', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(await toAttachment({ data: png, mimeType: 'image/png' })).toEqual({ kind: 'image', mimeType: 'image/png', data: png })
    const pdf = utf8('%PDF-1.4\n…')
    expect(await toAttachment({ data: pdf, mimeType: 'application/pdf' }, { filename: 'a.pdf' })).toMatchObject({ kind: 'pdf', filename: 'a.pdf' })
    await expect(toAttachment({ data: utf8('<html>'), mimeType: 'application/pdf' })).rejects.toThrow(UnsupportedFileError)
  })

  it('reads plain text and caps it', async () => {
    expect(await toAttachment({ data: utf8('﻿date,amount\n2026-09-01,5000\n'), mimeType: 'text/csv' }, { filename: 'x.csv' })).toEqual({
      kind: 'text',
      mimeType: 'text/csv',
      filename: 'x.csv',
      text: 'date,amount\n2026-09-01,5000',
    })
    const long = await toAttachment({ data: utf8('a'.repeat(MAX_TEXT_CHARS + 10)), mimeType: 'text/plain' })
    expect(long.text).toHaveLength(MAX_TEXT_CHARS)
    expect(long.truncated).toBe(true)
    await expect(toAttachment({ data: new Uint8Array([1, 0, 2]), mimeType: 'text/plain' })).rejects.toThrow(/binary/)
    await expect(toAttachment({ data: utf8('   '), mimeType: 'text/plain' })).rejects.toThrow(/no text/)
  })

  it('reads Word paragraphs, tabs and tables', async () => {
    const docx = zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Contract &amp; terms</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Due:</w:t><w:tab/><w:t>1 Oct</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:t>Item</w:t></w:p></w:tc><w:tc><w:p><w:t>Cost</w:t></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    })
    const a = await toAttachment({ data: docx, mimeType: `${OOXML}.wordprocessingml.document` }, { filename: 'c.docx' })
    expect(a.text).toContain('Contract & terms')
    expect(a.text).toContain('Due:\t1 Oct')
    expect(a.text).toMatch(/Item\s*\n?\s*\|\s*Cost/)
  })

  it('reads every Excel sheet by name, with shared strings and dates', async () => {
    const xlsx = zip({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Sep &amp; Oct" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Date</t></si><si><t>Item</t></si><si><r><t>Tax</t></r><r><t>i</t></r></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1"><v>7</v></c></row>' +
        '<row r="2"><c r="A2" s="1"><v>46296</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>',
    })
    const a = await toAttachment({ data: xlsx, mimeType: 'application/octet-stream' }, { filename: 'expenses.xlsx' })
    expect(a.text).toBe('## Sheet: Sep & Oct\nDate\tItem\t\t7\n2026-10-01\tTaxi\tTRUE\n\n## Sheet: Notes\nok')
  })

  it('reads PowerPoint slides in order', async () => {
    const pptx = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Plan</a:t></a:r></a:p><a:p><a:r><a:t>Budget</a:t></a:r></a:p></p:sld>',
    })
    const a = await toAttachment({ data: pptx, mimeType: `${OOXML}.presentationml.presentation` })
    expect(a.text).toBe('## Slide 2\nPlan\nBudget\n\n## Slide 10\nLast')
  })

  it('refuses broken or oversized Office files', async () => {
    await expect(toAttachment({ data: utf8('not a zip'), mimeType: `${OOXML}.wordprocessingml.document` })).rejects.toThrow(UnsupportedFileError)
    await expect(toAttachment({ data: zip({ 'other.xml': '<x/>' }), mimeType: `${OOXML}.wordprocessingml.document` })).rejects.toThrow(/not a Word/)
    // Declared size over the cap: refused before inflating.
    const big = zipSync({ 'word/document.xml': new Uint8Array(41 * 1024 * 1024) }, { level: 9 })
    await expect(toAttachment({ data: big, mimeType: `${OOXML}.wordprocessingml.document` })).rejects.toThrow(/too large/)
  })
})

describe('HEIC (iPhone photos sent as files)', () => {
  const heic = new Uint8Array(readFileSync(path.resolve(import.meta.dirname, '../../../fixtures/files/receipt.heic')))

  it('converts to JPEG the model can read', async () => {
    const a = await toAttachment({ data: heic, mimeType: 'image/heic' }, { filename: 'IMG_0001.HEIC' })
    expect(a).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', filename: 'IMG_0001.HEIC' })
    const decoded = jpeg.decode(a.data!)
    expect([decoded.width, decoded.height]).toEqual([800, 800])
    // Top-left is white paper, as in the original.
    expect([...decoded.data.subarray(0, 3)].every((v) => v > 240)).toBe(true)
  })

  it('refuses a file that only claims to be HEIC', async () => {
    await expect(toAttachment({ data: utf8('not an image'), mimeType: 'image/heic' })).rejects.toThrow(/HEIC/)
  })

  it('downscales large images by area average', () => {
    const src = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) }
    for (let i = 0; i < 8; i++) src.data.set(i % 4 < 2 ? [0, 0, 0, 255] : [200, 100, 50, 255], i * 4)
    const out = downscale(src, 2)
    expect([out.width, out.height]).toEqual([2, 1])
    expect([...out.data]).toEqual([0, 0, 0, 255, 200, 100, 50, 255])
    // Already small enough: the same pixels, untouched.
    expect(downscale(src, 10).data).toBe(src.data)
  })
})
