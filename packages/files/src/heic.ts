import { createRequire } from 'node:module'
import jpeg from 'jpeg-js'

/**
 * HEIC/HEIF (the iPhone camera's format) → JPEG. Neither model API takes HEIC. WhatsApp and
 * Telegram convert iPhone photos sent as photos; HEIC only arrives when sent as a file.
 * Pure WebAssembly (libheif-js) and JavaScript: no native binaries on the host.
 */

type Decoded = { width: number; height: number; data: Uint8ClampedArray }
type Decode = (input: { buffer: Uint8Array }) => Promise<Decoded>

// heic-decode is CommonJS without types; loaded on first use (the WASM bundle is large).
let decoder: Decode | undefined
const decodeHeic: Decode = (input) => {
  decoder ??= createRequire(import.meta.url)('heic-decode') as Decode
  return decoder(input)
}

/** The models scale larger images down anyway; this keeps the JPEG small and fast to encode. */
export const MAX_IMAGE_EDGE = 2048
const JPEG_QUALITY = 85

/** Area-average downscale of RGBA pixels so the longer edge is at most `maxEdge`. */
export function downscale(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, maxEdge: number) {
  const scale = Math.max(img.width, img.height) / maxEdge
  if (scale <= 1) return { width: img.width, height: img.height, data: img.data }
  const width = Math.max(1, Math.round(img.width / scale))
  const height = Math.max(1, Math.round(img.height / scale))
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * img.height) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * img.width) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / width))
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * img.width + x0) * 4
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += img.data[i]!
          g += img.data[i + 1]!
          b += img.data[i + 2]!
          a += img.data[i + 3]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return { width, height, data: out }
}

/** Throws if the file isn't a HEIC image libheif can decode. */
export async function heicToJpeg(data: Uint8Array): Promise<Uint8Array> {
  const image = downscale(await decodeHeic({ buffer: data }), MAX_IMAGE_EDGE)
  const encoded = jpeg.encode({ width: image.width, height: image.height, data: image.data }, JPEG_QUALITY)
  return new Uint8Array(encoded.data)
}
