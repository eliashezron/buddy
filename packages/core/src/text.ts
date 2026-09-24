/** Splits on paragraph, then line, then word boundaries so no chunk exceeds `max`. */
export function splitText(text: string, max: number): string[] {
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
