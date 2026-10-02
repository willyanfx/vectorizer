// Background detection for the "Keep background" toggle.
//
// The background is whatever color dominates the image border. We sample the
// border of a small copy of the source image, and if one color clearly wins we
// match it to the nearest traced color layer.

import { decodeImage } from '../gpu'
import { parseColor, toHex } from './layers'
import type { ColorLayer } from './vectorView'

const SAMPLE_SIZE = 128 // longest side of the downscaled copy
const MIN_SHARE = 0.6 // fraction of border pixels the winning color must cover
const MAX_DISTANCE = 48 // RGB distance for matching a traced layer

/** Dominant opaque border color as "#RRGGBB", or null if there isn't one. */
export async function detectBackgroundColor(file: Blob): Promise<string | null> {
  const bitmap = await decodeImage(file)
  try {
    const scale = Math.min(1, SAMPLE_SIZE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)

    // Bucket border pixels by 4 bits per channel; remember the sums so the
    // winner is reported as the true average of its bucket.
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
    let total = 0
    const sample = (x: number, y: number) => {
      const o = (y * w + x) * 4
      total++
      if (data[o + 3] < 128) return // transparent: already no background here
      const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4)
      const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
      b.n++
      b.r += data[o]
      b.g += data[o + 1]
      b.b += data[o + 2]
      buckets.set(key, b)
    }
    for (let x = 0; x < w; x++) {
      sample(x, 0)
      if (h > 1) sample(x, h - 1)
    }
    for (let y = 1; y < h - 1; y++) {
      sample(0, y)
      if (w > 1) sample(w - 1, y)
    }

    let best: { n: number; r: number; g: number; b: number } | null = null
    for (const b of buckets.values()) if (!best || b.n > best.n) best = b
    if (!best || best.n < total * MIN_SHARE) return null
    return toHex([best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) as [number, number, number])
  } finally {
    bitmap.close()
  }
}

/** The traced layer closest to the background color, if any is close enough. */
export function matchBackgroundLayer(layers: ColorLayer[], background: string | null): string | null {
  const target = background ? parseColor(background) : null
  if (!target) return null
  let best: string | null = null
  let bestDist = MAX_DISTANCE
  for (const layer of layers) {
    const rgb = parseColor(layer.color)
    if (!rgb) continue
    const d = Math.hypot(rgb[0] - target[0], rgb[1] - target[1], rgb[2] - target[2])
    if (d < bestDist) {
      bestDist = d
      best = layer.color
    }
  }
  return best
}
