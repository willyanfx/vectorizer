// Canvas-based image decode + preprocessing. This is BOTH:
//   1. the universal decode path (used on every run to turn a File into RGBA
//      pixels for the worker), and
//   2. the preprocessing fallback when WebGPU is unavailable (resize + blur +
//      quantize), mapping 1:1 onto the GPU stages.
//
// Returns a plain { pixels, width, height } so callers are agnostic to whether
// the GPU or Canvas path ran.

import type { PixelData } from '../lib/params'

/** Binarization mode applied after resize/blur. 'sauvola' is best for text. */
export type ThresholdMode = 'off' | 'sauvola'

export interface PreprocessOptions {
  maxSize: number // longest side clamp (downsample if larger)
  minSize: number // longest side floor (UPSCALE if smaller; 0 = off). For text.
  blur: number // gaussian/box blur radius in px (0 = none)
  quantizeColors: number // 0 = off, else reduce to N colors
  threshold: ThresholdMode // adaptive binarization (Sauvola) — for text/scans
}

export const DEFAULT_PREPROCESS: PreprocessOptions = {
  maxSize: 2048,
  minSize: 0,
  blur: 0,
  quantizeColors: 0,
  threshold: 'off',
}

/**
 * Target dimensions after applying the size floor (upscale) and ceiling
 * (downscale). minSize wins first — a small text image is upscaled so hairline
 * strokes survive tracing — then maxSize clamps if the result is too large.
 */
function targetSize(w: number, h: number, maxSize: number, minSize = 0): [number, number] {
  let longest = Math.max(w, h)
  let scale = 1
  if (minSize > 0 && longest < minSize) scale = minSize / longest
  longest *= scale
  if (longest > maxSize) scale *= maxSize / longest
  if (scale === 1) return [w, h]
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]
}

/** True if the 2D context honors the `filter` property (most do; old Safari workers don't). */
function supportsCtxFilter(ctx: OffscreenCanvasRenderingContext2D): boolean {
  return 'filter' in ctx
}

/** Draw a source bitmap into an OffscreenCanvas at target size, optionally blurred. */
function drawToCanvas(
  src: ImageBitmap,
  w: number,
  h: number,
  blur: number,
): ImageData {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D context unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  let blurred = false
  if (blur > 0 && supportsCtxFilter(ctx)) {
    ctx.filter = `blur(${blur}px)`
    blurred = true
  }
  ctx.drawImage(src, 0, 0, w, h)
  ctx.filter = 'none'

  const imageData = ctx.getImageData(0, 0, w, h)
  if (blur > 0 && !blurred) {
    boxBlur(imageData, Math.round(blur))
  }
  return imageData
}

/** Cheap separable box blur fallback for contexts without ctx.filter. */
function boxBlur(img: ImageData, radius: number) {
  if (radius < 1) return
  const { data, width, height } = img
  const tmp = new Uint8ClampedArray(data)
  const r = radius
  const passes: [Uint8ClampedArray, Uint8ClampedArray][] = [
    [data, tmp],
    [tmp, data],
  ]
  // horizontal then vertical
  blurAxis(passes[0][0], passes[0][1], width, height, r, true)
  blurAxis(passes[1][0], passes[1][1], width, height, r, false)
}

function blurAxis(
  srcArr: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  r: number,
  horizontal: boolean,
) {
  const len = horizontal ? width : height
  const lines = horizontal ? height : width
  const win = r * 2 + 1
  for (let line = 0; line < lines; line++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0
      const idx = (i: number) =>
        horizontal ? (line * width + i) * 4 + c : (i * width + line) * 4 + c
      for (let i = -r; i <= r; i++) sum += srcArr[idx(Math.min(Math.max(i, 0), len - 1))]
      for (let i = 0; i < len; i++) {
        dst[idx(i)] = sum / win
        const out = idx(Math.min(Math.max(i - r, 0), len - 1))
        const inn = idx(Math.min(Math.max(i + r + 1, 0), len - 1))
        sum += srcArr[inn] - srcArr[out]
      }
    }
  }
}

/** Median-cut color quantization in JS. Mutates `img.data` in place. */
function medianCutQuantize(img: ImageData, colors: number) {
  if (colors < 2) return
  const { data } = img
  type Box = { pixels: number[] } // indices into data (pixel start, step 4)
  const all: number[] = []
  for (let i = 0; i < data.length; i += 4) all.push(i)

  function channelRange(idxs: number[], ch: number): number {
    let min = 255
    let max = 0
    for (const i of idxs) {
      const v = data[i + ch]
      if (v < min) min = v
      if (v > max) max = v
    }
    return max - min
  }
  function widestChannel(idxs: number[]): number {
    let best = 0
    let bestRange = -1
    for (let ch = 0; ch < 3; ch++) {
      const r = channelRange(idxs, ch)
      if (r > bestRange) {
        bestRange = r
        best = ch
      }
    }
    return best
  }

  let boxes: Box[] = [{ pixels: all }]
  while (boxes.length < colors) {
    // split the box with the largest pixel count and non-zero range
    let target = -1
    let max = 0
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b]
      if (box.pixels.length > max && widestChannel(box.pixels) >= 0 && box.pixels.length > 1) {
        max = box.pixels.length
        target = b
      }
    }
    if (target < 0) break
    const box = boxes[target]
    const ch = widestChannel(box.pixels)
    box.pixels.sort((a, b) => data[a + ch] - data[b + ch])
    const mid = box.pixels.length >> 1
    const a: Box = { pixels: box.pixels.slice(0, mid) }
    const c: Box = { pixels: box.pixels.slice(mid) }
    boxes = boxes.filter((_, i) => i !== target).concat([a, c])
  }

  // map each box to its average color, write back
  for (const box of boxes) {
    let r = 0
    let g = 0
    let b = 0
    for (const i of box.pixels) {
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
    }
    const n = box.pixels.length || 1
    r = Math.round(r / n)
    g = Math.round(g / n)
    b = Math.round(b / n)
    for (const i of box.pixels) {
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
}

/**
 * Adaptive binarization for text/scans. Pipeline (all in place on `img.data`):
 *   grayscale → contrast stretch (p2..p98) → Sauvola local threshold.
 *
 * Sauvola computes a per-pixel threshold T = m·(1 + k·(s/R − 1)) where m and s
 * are the local mean and std-dev over a window. It adapts to uneven lighting and
 * faded ink far better than a global (Otsu) threshold, so thin serif strokes on
 * cream paper survive instead of being washed out. Mean/variance over the window
 * are read in O(1) from integral images, so the whole pass is O(N).
 *
 * Output is pure 1-bit: ink → #000, paper → #fff (alpha preserved), which is the
 * ideal input for VTracer's binary mode (no anti-alias halos to trace).
 */
export function sauvolaThreshold(img: ImageData, blockSize = 25, k = 0.1) {
  const { data, width: W, height: H } = img
  const n = W * H

  // 1. Grayscale luminance.
  const gray = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
  }

  // 2. Contrast stretch using 2nd/98th percentiles (robust to outliers).
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) hist[gray[i] | 0]++
  const lo = percentile(hist, n, 0.02)
  const hi = percentile(hist, n, 0.98)
  if (hi > lo) {
    const span = 255 / (hi - lo)
    for (let i = 0; i < n; i++) {
      gray[i] = Math.max(0, Math.min(255, (gray[i] - lo) * span))
    }
  }

  // 3. Integral images of value and value² (row-padded by 1 for clean borders).
  const SW = W + 1
  const sum = new Float64Array(SW * (H + 1))
  const sqsum = new Float64Array(SW * (H + 1))
  for (let y = 0; y < H; y++) {
    let rowSum = 0
    let rowSq = 0
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x]
      rowSum += v
      rowSq += v * v
      const idx = (y + 1) * SW + (x + 1)
      sum[idx] = sum[idx - SW] + rowSum
      sqsum[idx] = sqsum[idx - SW] + rowSq
    }
  }

  // 4. Per-pixel Sauvola threshold over a (2r+1)² window.
  const r = Math.max(1, blockSize >> 1)
  const R = 128 // dynamic range of std-dev
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(H - 1, y + r)
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(W - 1, x + r)
      const area = (y1 - y0 + 1) * (x1 - x0 + 1)
      // inclusive-window box sum via the integral image corners
      const A = y0 * SW + x0
      const B = y0 * SW + (x1 + 1)
      const C = (y1 + 1) * SW + x0
      const D = (y1 + 1) * SW + (x1 + 1)
      const s1 = sum[D] - sum[B] - sum[C] + sum[A]
      const s2 = sqsum[D] - sqsum[B] - sqsum[C] + sqsum[A]
      const mean = s1 / area
      const variance = Math.max(0, s2 / area - mean * mean)
      const std = Math.sqrt(variance)
      const t = mean * (1 + k * (std / R - 1))
      const ink = gray[y * W + x] < t
      const j = (y * W + x) * 4
      const v = ink ? 0 : 255
      data[j] = v
      data[j + 1] = v
      data[j + 2] = v
      // alpha left untouched
    }
  }
}

/** Value at the given cumulative fraction of a 256-bin histogram. */
function percentile(hist: Uint32Array, total: number, frac: number): number {
  const target = total * frac
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) return v
  }
  return 255
}

// Hard ceiling: refuse to decode at full resolution above this longest side, to
// avoid OOM on huge uploads. createImageBitmap can resize during decode, so we
// downscale at decode time rather than allocating the full bitmap first.
const DECODE_CEILING = 8192

/** Decode a File/Blob to an ImageBitmap (orientation-aware, size-guarded). */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  // Cheap probe of intrinsic size without fully decoding to a canvas.
  let probe: ImageBitmap | null = null
  try {
    probe = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // Some browsers reject options; retry without them.
    probe = await createImageBitmap(file)
  }
  const longest = Math.max(probe.width, probe.height)
  if (longest <= DECODE_CEILING) return probe

  // Too large — re-decode with a resize and release the oversized probe.
  const scale = DECODE_CEILING / longest
  const w = Math.round(probe.width * scale)
  const h = Math.round(probe.height * scale)
  probe.close()
  return createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'high',
  })
}

/** Full Canvas preprocessing: resize → blur → threshold/quantize → RGBA pixels. */
export function preprocessCanvas(src: ImageBitmap, opts: PreprocessOptions): PixelData {
  const [w, h] = targetSize(src.width, src.height, opts.maxSize, opts.minSize)
  const img = drawToCanvas(src, w, h, opts.blur)
  // Threshold (text) and quantize (color) are mutually exclusive; threshold wins.
  if (opts.threshold === 'sauvola') sauvolaThreshold(img)
  else if (opts.quantizeColors >= 2) medianCutQuantize(img, opts.quantizeColors)
  // ImageData.data is Uint8ClampedArray; the worker wants a Uint8Array view.
  const pixels = new Uint8Array(img.data.buffer.slice(0))
  return { pixels, width: w, height: h }
}
