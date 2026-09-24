/** WhatsApp caps text bodies at 4096 characters. Leave headroom. */
export const MAX_TEXT_LENGTH = 4000

/**
 * Converts common Markdown into WhatsApp's formatting dialect:
 * `**bold**` → `*bold*`, `# Heading` → `*Heading*`, `[label](url)` → `label: url`,
 * `~~strike~~` → `~strike~`. Code spans and single `*`/`_` pass through.
 */
export function toWhatsAppText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label}: ${url}`,
    )
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Splits on paragraph, then line, then word boundaries so no chunk exceeds `max`. */
export function splitMessage(text: string, max = MAX_TEXT_LENGTH): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n\n')
    if (cut < max * 0.5) cut = window.lastIndexOf('\n')
    if (cut < max * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}
