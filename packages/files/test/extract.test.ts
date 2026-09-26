import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { fileFormat, MAX_TEXT_CHARS, toAttachment, UnsupportedFileError } from '../src/index.js'

const OOXML = 'application/vnd.openxmlformats-officedocument'
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
const utf8 = (s: string) => new TextEncoder().encode(s)

describe('fileFormat', () => {
  it('uses the MIME type, then the extension', () => {
    expect(fileFormat('image/jpeg')).toBe('image')
    expect(fileFormat('application/pdf')).toBe('pdf')
    expect(fileFormat('text/csv; charset=utf-8')).toBe('text')
    expect(fileFormat(`${OOXML}.spreadsheetml.sheet`)).toBe('xlsx')
    expect(fileFormat('application/octet-stream', 'Budget.XLSX')).toBe('xlsx')
    expect(fileFormat(undefined, 'scan.png')).toBe('image')
  })

  it('refuses what we cannot read', () => {
    expect(fileFormat('application/zip', 'photos.zip')).toBeNull()
    expect(fileFormat('application/msword', 'old.doc')).toBeNull()
    expect(fileFormat('image/heic', 'IMG_0001.HEIC')).toBeNull()
    expect(fileFormat('text/html', 'page.html')).toBeNull()
  })
})

describe('toAttachment', () => {
  it('passes images and PDFs through', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(toAttachment({ data: png, mimeType: 'image/png' })).toEqual({ kind: 'image', mimeType: 'image/png', data: png })
    const pdf = utf8('%PDF-1.4\n…')
    expect(toAttachment({ data: pdf, mimeType: 'application/pdf' }, { filename: 'a.pdf' })).toMatchObject({ kind: 'pdf', filename: 'a.pdf' })
    expect(() => toAttachment({ data: utf8('<html>'), mimeType: 'application/pdf' })).toThrow(UnsupportedFileError)
  })

  it('reads plain text and caps it', () => {
    expect(toAttachment({ data: utf8('﻿date,amount\n2026-09-01,5000\n'), mimeType: 'text/csv' }, { filename: 'x.csv' })).toEqual({
      kind: 'text',
      mimeType: 'text/csv',
      filename: 'x.csv',
      text: 'date,amount\n2026-09-01,5000',
    })
    const long = toAttachment({ data: utf8('a'.repeat(MAX_TEXT_CHARS + 10)), mimeType: 'text/plain' })
    expect(long.text).toHaveLength(MAX_TEXT_CHARS)
    expect(long.truncated).toBe(true)
    expect(() => toAttachment({ data: new Uint8Array([1, 0, 2]), mimeType: 'text/plain' })).toThrow(/binary/)
    expect(() => toAttachment({ data: utf8('   '), mimeType: 'text/plain' })).toThrow(/no text/)
  })

  it('reads Word paragraphs, tabs and tables', () => {
    const docx = zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Contract &amp; terms</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Due:</w:t><w:tab/><w:t>1 Oct</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:t>Item</w:t></w:p></w:tc><w:tc><w:p><w:t>Cost</w:t></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    })
    const a = toAttachment({ data: docx, mimeType: `${OOXML}.wordprocessingml.document` }, { filename: 'c.docx' })
    expect(a.text).toContain('Contract & terms')
    expect(a.text).toContain('Due:\t1 Oct')
    expect(a.text).toMatch(/Item\s*\n?\s*\|\s*Cost/)
  })

  it('reads every Excel sheet by name, with shared strings and dates', () => {
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
    const a = toAttachment({ data: xlsx, mimeType: 'application/octet-stream' }, { filename: 'expenses.xlsx' })
    expect(a.text).toBe('## Sheet: Sep & Oct\nDate\tItem\t\t7\n2026-10-01\tTaxi\tTRUE\n\n## Sheet: Notes\nok')
  })

  it('reads PowerPoint slides in order', () => {
    const pptx = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Plan</a:t></a:r></a:p><a:p><a:r><a:t>Budget</a:t></a:r></a:p></p:sld>',
    })
    const a = toAttachment({ data: pptx, mimeType: `${OOXML}.presentationml.presentation` })
    expect(a.text).toBe('## Slide 2\nPlan\nBudget\n\n## Slide 10\nLast')
  })

  it('refuses broken or oversized Office files', () => {
    expect(() => toAttachment({ data: utf8('not a zip'), mimeType: `${OOXML}.wordprocessingml.document` })).toThrow(UnsupportedFileError)
    expect(() => toAttachment({ data: zip({ 'other.xml': '<x/>' }), mimeType: `${OOXML}.wordprocessingml.document` })).toThrow(/not a Word/)
    // Declared size over the cap: refused before inflating.
    const big = zipSync({ 'word/document.xml': new Uint8Array(41 * 1024 * 1024) }, { level: 9 })
    expect(() => toAttachment({ data: big, mimeType: `${OOXML}.wordprocessingml.document` })).toThrow(/too large/)
  })
})
