import { splitText } from '@wa/core'

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

export function splitMessage(text: string, max = MAX_TEXT_LENGTH): string[] {
  return splitText(text, max)
}
