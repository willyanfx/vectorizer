// Embedded images: placeholders in the SVG, filled with (downscaled) data URIs.

import { sniffMime, toBase64, type Unzipped } from './util'

export async function processImages(
  files: Unzipped,
  needs: Map<string, { w: number; h: number }>,
  scale: number,
  onProgress?: (message: string) => void,
): Promise<Map<string, string>> {
  const uris = new Map<string, string>()
  let done = 0
  for (const [key, size] of needs) {
    onProgress?.(`Processing images ${++done}/${needs.size}…`)
    const uri = await imageDataUri(files[`resources/${key}`], size, scale)
    if (uri) uris.set(key, uri)
  }
  return uris
}

// 1×1 transparent PNG: keeps <image> boxes clickable without the image data.
export const BLANK_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export function fillImages(template: string, uris: Map<string, string> | 'blank'): string {
  return template.replace(/__XDIMG_([\w.-]+)__/g, (_, k: string) => (uris === 'blank' ? BLANK_IMAGE : (uris.get(k) ?? '')))
}

/**
 * Data URI for an embedded image, downscaled so it still covers its largest
 * on-artboard box at `scale`× (never upscaled). Opaque images become JPEG,
 * images with transparency stay PNG — both formats jsPDF can embed.
 */
export async function imageDataUri(
  bytes: Uint8Array | undefined,
  box: { w: number; h: number },
  scale: number,
): Promise<string | null> {
  if (!bytes) return null
  const mime = sniffMime(bytes)
  if (!mime || mime === 'image/svg+xml') return null
  const original = `data:${mime};base64,${toBase64(bytes)}`
  if (!scale || typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return original

  let bmp: ImageBitmap | null = null
  try {
    const blob = new Blob([bytes as BlobPart], { type: mime })
    bmp = await createImageBitmap(blob)
    const { width: iw, height: ih } = bmp
    // "cover" fit: the image is scaled so both box dimensions are filled.
    const s = Math.max(box.w / iw, box.h / ih) * scale
    const keepOriginal = !(s > 0) || s >= 0.9 // within 10%: not worth re-encoding
    if (keepOriginal && (mime === 'image/png' || mime === 'image/jpeg')) return original
    const w = Math.max(1, Math.round(iw * Math.min(1, s || 1)))
    const h = Math.max(1, Math.round(ih * Math.min(1, s || 1)))
    const canvas = new OffscreenCanvas(w, h)
    const g = canvas.getContext('2d')
    if (!g) return original
    g.imageSmoothingQuality = 'high'
    g.drawImage(bmp, 0, 0, w, h)
    const px = g.getImageData(0, 0, w, h).data
    let opaque = true
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 255) {
        opaque = false
        break
      }
    }
    const out = await canvas.convertToBlob(opaque ? { type: 'image/jpeg', quality: 0.88 } : { type: 'image/png' })
    const outBytes = new Uint8Array(await out.arrayBuffer())
    return outBytes.length < bytes.length ? `data:${out.type};base64,${toBase64(outBytes)}` : original
  } catch {
    return original
  } finally {
    bmp?.close()
  }
}
