import { describe, expect, it } from 'vitest'
import { MAX_TEXT_LENGTH, splitMessage, toWhatsAppText } from '../src/format.js'

describe('toWhatsAppText', () => {
  it('converts Markdown to WhatsApp formatting', () => {
    const md = '## Options\n\n**Kololo Hall** holds 20.\n- [Site](https://example.com)\n- ~~old~~'
    expect(toWhatsAppText(md)).toBe('*Options*\n\n*Kololo Hall* holds 20.\n• Site: https://example.com\n• ~old~')
  })

  it('leaves WhatsApp formatting alone', () => {
    expect(toWhatsAppText('*bold* and _italic_')).toBe('*bold* and _italic_')
  })
})

describe('splitMessage', () => {
  it('keeps every chunk within the limit and loses nothing but boundary whitespace', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ')
    const chunks = splitMessage(words)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
    expect(chunks.join(' ')).toBe(words)
  })
})
