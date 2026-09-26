import { unzipSync } from 'fflate'

/**
 * Text from Word, Excel and PowerPoint files (Office Open XML: a zip of XML parts). Only the
 * parts we read are unzipped, and their declared sizes are capped, so a zip bomb is refused
 * before anything is inflated.
 */

const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024
const MAX_ROWS_PER_SHEET = 2_000

export class OfficeFileError extends Error {
  override name = 'OfficeFileError'
}

function unzip(data: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (!wanted(f.name)) return false
        total += f.originalSize
        if (total > MAX_UNZIPPED_BYTES) throw new OfficeFileError('file is too large once unpacked')
        return true
      },
    })
  } catch (err) {
    if (err instanceof OfficeFileError) throw err
    throw new OfficeFileError('not a valid Office file')
  }
  const decoder = new TextDecoder()
  return new Map(Object.entries(files).map(([name, bytes]) => [name, decoder.decode(bytes)]))
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

const stripTags = (xml: string) => decodeXml(xml.replace(/<[^>]+>/g, ''))
const tidy = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
/** Numeric order for part names like slide10.xml / sheet2.xml. */
const partNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)

/** Word: paragraphs, line breaks, tabs, and tables as " | "-separated rows. */
export function docxText(data: Uint8Array): string {
  const parts = unzip(data, (n) => n === 'word/document.xml')
  const xml = parts.get('word/document.xml')
  if (xml === undefined) throw new OfficeFileError('not a Word document')
  return tidy(
    stripTags(
      xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:tc>/g, ' | ')
        .replace(/<\/w:p>/g, '\n'),
    ).replace(/ \| \n/g, '\n'),
  )
}

/** PowerPoint: each slide's text, in slide order. */
export function pptxText(data: Uint8Array): string {
  const parts = unzip(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  if (!parts.size) throw new OfficeFileError('not a PowerPoint file')
  const slides = [...parts.entries()].sort(([a], [b]) => partNumber(a) - partNumber(b))
  return slides
    .map(([name, xml]) => `## Slide ${partNumber(name)}\n${tidy(stripTags(xml.replace(/<\/a:p>/g, '\n')))}`)
    .join('\n\n')
}

/** Built-in number formats that are dates or times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** Which cell styles (the `s` attribute) show numbers as dates. */
function dateStyles(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>()
  if (!stylesXml) return out
  const custom = new Map<number, string>()
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), decodeXml(m[2]!))
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? ''
  let i = 0
  for (const m of xfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1]!)?.[1] ?? 0)
    // Custom formats: a date if it has d/m/y outside quoted text and [colour] blocks.
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '')
    if (DATE_FORMAT_IDS.has(id) || (code && /[dy]|m{3,}/i.test(code))) out.add(i)
    i++
  }
  return out
}

/** Excel serial date → ISO date (and time, when there is one). 1900 system. */
function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000)
  const iso = new Date(ms).toISOString()
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ')
}

const columnIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1

/** Excel: every sheet as tab-separated rows, with its name. Dates as YYYY-MM-DD. */
export function xlsxText(data: Uint8Array): string {
  const parts = unzip(
    data,
    (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || n === 'xl/styles.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  )
  const workbook = parts.get('xl/workbook.xml')
  if (workbook === undefined) throw new OfficeFileError('not an Excel file')

  const shared = [...(parts.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    // Rich text: only <t> runs are text (phonetic <rPh> hints are not).
    decodeXml([...m[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  )
  const dates = dateStyles(parts.get('xl/styles.xml'))
  const targets = new Map<string, string>()
  for (const m of (parts.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1]!)?.[1]
    const target = /Target="([^"]+)"/.exec(m[1]!)?.[1]
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
  }

  const out: string[] = []
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)]
  sheets.forEach((s, i) => {
    const name = decodeXml(/name="([^"]*)"/.exec(s[1]!)?.[1] ?? `Sheet${i + 1}`)
    const rid = /r:id="([^"]+)"/.exec(s[1]!)?.[1]
    const xml = parts.get((rid && targets.get(rid)) ?? `xl/worksheets/sheet${i + 1}.xml`)
    if (xml === undefined) return
    const rows: string[] = []
    let more = 0
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS_PER_SHEET) {
        more++
        continue
      }
      const cells: string[] = []
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!
        const body = c[2] ?? ''
        const type = /\bt="(\w+)"/.exec(attrs)?.[1]
        const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1)
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        let value = ''
        if (type === 's') value = shared[Number(v)] ?? ''
        else if (type === 'inlineStr') value = stripTags(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
        else if (v !== undefined) value = !type && dates.has(style) && Number.isFinite(Number(v)) ? serialToIso(Number(v)) : decodeXml(v)
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]
        const col = ref ? columnIndex(ref) : cells.length
        while (cells.length < col) cells.push('')
        cells[col] = value.replace(/[\t\n]+/g, ' ')
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t').trimEnd())
    }
    if (more) rows.push(`… ${more} more rows not shown`)
    out.push(`## Sheet: ${name}\n${rows.join('\n')}`)
  })
  return out.join('\n\n')
}
