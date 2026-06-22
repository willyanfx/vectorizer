// Canvas-based image decode + preprocessing. This is BOTH:
//   1. the universal decode path (used on every run to turn a File into RGBA
//      pixels for the worker), and
//   2. the preprocessing fallback when WebGPU is unavailable (resize + blur +
//      quantize), mapping 1:1 onto the GPU stages.
//
// Returns a plain { pixels, width, height } so callers are agnostic to whether
// the GPU or Canvas path ran.

import type { PixelData } from '../lib/params'

export interface PreprocessOptions {
  maxSize: number // longest side clamp (downsample if larger)
  blur: number // gaussian/box blur radius in px (0 = none)
  quantizeColors: number // 0 = off, else reduce to N colors
}

export const DEFAULT_PREPROCESS: PreprocessOptions = {
  maxSize: 2048,
  blur: 0,
  quantizeColors: 0,
}

function targetSize(w: number, h: number, maxSize: number): [number, number] {
  const longest = Math.max(w, h)
  if (longest <= maxSize) return [w, h]
  const scale = maxSize / longest
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

/** Full Canvas preprocessing: resize → blur → quantize → RGBA pixels. */
export function preprocessCanvas(src: ImageBitmap, opts: PreprocessOptions): PixelData {
  const [w, h] = targetSize(src.width, src.height, opts.maxSize)
  const img = drawToCanvas(src, w, h, opts.blur)
  if (opts.quantizeColors >= 2) medianCutQuantize(img, opts.quantizeColors)
  // ImageData.data is Uint8ClampedArray; the worker wants a Uint8Array view.
  const pixels = new Uint8Array(img.data.buffer.slice(0))
  return { pixels, width: w, height: h }
}
