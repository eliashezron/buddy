/** Telegram caps messages at 4096 characters of text. Leave headroom for markup. */
export const MAX_TEXT_LENGTH = 3800

const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeAttr = (s: string) => escapeHtml(s).replaceAll('"', '&quot;')

/**
 * Converts the agent's light Markdown to Telegram's HTML parse mode. Everything is
 * escaped first, so model or web text can never inject tags; only the patterns
 * below produce markup. Supported by Telegram: b, i, s, code, a.
 */
export function toTelegramHtml(markdown: string): string {
  const links: string[] = []
  let text = markdown.replace(/\r\n/g, '\n')
  // Pull links out before escaping so their URLs can be attribute-escaped separately.
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`)
    return `\u0000${links.length - 1}\u0000`
  })
  text = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]!)
}

/** Plain-text fallback if Telegram rejects our markup: drop the Markdown markers. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .trim()
}
