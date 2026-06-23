// WebGPU preprocessing: blur + quantize as compute passes.
//
// Resize is done with OffscreenCanvas.drawImage (browser-accelerated, robust),
// then the RGBA pixels are uploaded to a storage buffer and run through the
// gaussian + quantize compute shaders. Results are read back to a Uint8Array.
//
// Pixels are stored as vec4<f32> (linear 0..1) on the GPU for filter precision,
// converted back to u8 RGBA on readback.

import type { PixelData } from '../lib/params'
import { sauvolaThreshold, type PreprocessOptions } from './cpu-fallback'
import gaussianWgsl from './shaders/gaussian.wgsl?raw'
import quantizeWgsl from './shaders/quantize.wgsl?raw'

// Apply the size floor (upscale small text) then the ceiling (clamp large), to
// match the Canvas path in cpu-fallback.ts.
function targetSize(w: number, h: number, maxSize: number, minSize = 0): [number, number] {
  let longest = Math.max(w, h)
  let s = 1
  if (minSize > 0 && longest < minSize) s = minSize / longest
  longest *= s
  if (longest > maxSize) s *= maxSize / longest
  if (s === 1) return [w, h]
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

export class WebGPUPreprocessor {
  private device: GPUDevice
  private gaussianPipeline: GPUComputePipeline
  private quantizePipeline: GPUComputePipeline

  private constructor(device: GPUDevice) {
    this.device = device
    const gaussianModule = device.createShaderModule({ code: gaussianWgsl })
    const quantizeModule = device.createShaderModule({ code: quantizeWgsl })
    this.gaussianPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: gaussianModule, entryPoint: 'main' },
    })
    this.quantizePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: quantizeModule, entryPoint: 'main' },
    })
  }

  static async create(): Promise<WebGPUPreprocessor | null> {
    if (!('gpu' in navigator) || !navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return null
    const device = await adapter.requestDevice()
    return new WebGPUPreprocessor(device)
  }

  /** Resize via canvas, then blur + quantize via compute. Returns RGBA pixels. */
  async process(src: ImageBitmap, opts: PreprocessOptions): Promise<PixelData> {
    const [w, h] = targetSize(src.width, src.height, opts.maxSize, opts.minSize)

    // Resize on a canvas, get u8 RGBA.
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, w, h)
    const imageData = ctx.getImageData(0, 0, w, h)
    const u8 = imageData.data

    // Adaptive threshold (text) is a CPU finalizing step run on the readback so
    // both backends produce identical output. Blur is intentionally skipped for
    // text — it softens ink edges before binarization. Threshold supersedes
    // quantize (you wouldn't color-reduce a 1-bit image).
    const thresholding = opts.threshold === 'sauvola'
    const needsBlur = opts.blur >= 1 && !thresholding
    const needsQuantize = opts.quantizeColors >= 2 && !thresholding
    if (!needsBlur && !needsQuantize) {
      if (thresholding) sauvolaThreshold(imageData)
      return { pixels: new Uint8Array(u8.buffer.slice(0)), width: w, height: h }
    }

    const device = this.device
    const count = w * h
    const f32 = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      f32[i * 4] = u8[i * 4] / 255
      f32[i * 4 + 1] = u8[i * 4 + 1] / 255
      f32[i * 4 + 2] = u8[i * 4 + 2] / 255
      f32[i * 4 + 3] = u8[i * 4 + 3] / 255
    }

    const byteLen = f32.byteLength
    const bufA = device.createBuffer({
      size: byteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    const bufB = device.createBuffer({
      size: byteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(bufA, 0, f32)

    const wgX = Math.ceil(w / 8)
    const wgY = Math.ceil(h / 8)

    // ping-pong between bufA (read) and bufB (write)
    let read = bufA
    let write = bufB
    const swap = () => {
      const t = read
      read = write
      write = t
    }

    const encoder = device.createCommandEncoder()

    const runPass = (
      pipeline: GPUComputePipeline,
      paramsData: Int32Array | Uint32Array,
    ) => {
      const paramBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(paramBuf, 0, paramsData)
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: read } },
          { binding: 1, resource: { buffer: write } },
          { binding: 2, resource: { buffer: paramBuf } },
        ],
      })
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(wgX, wgY)
      pass.end()
      swap()
    }

    if (needsBlur) {
      const r = Math.round(opts.blur)
      // horizontal then vertical
      runPass(this.gaussianPipeline, new Int32Array([w, h, r, 0]))
      runPass(this.gaussianPipeline, new Int32Array([w, h, r, 1]))
    }
    if (needsQuantize) {
      // map "quantize colors" to per-channel levels: cbrt(N) so total ~= N.
      const levels = Math.max(2, Math.round(Math.cbrt(opts.quantizeColors)))
      runPass(this.quantizePipeline, new Uint32Array([w, h, levels, 0]))
    }

    // copy final `read` buffer to a mappable buffer
    const readback = device.createBuffer({
      size: byteLen,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    encoder.copyBufferToBuffer(read, 0, readback, 0, byteLen)
    device.queue.submit([encoder.finish()])

    await readback.mapAsync(GPUMapMode.READ)
    const result = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()

    const out = new Uint8Array(count * 4)
    for (let i = 0; i < count * 4; i++) {
      out[i] = Math.max(0, Math.min(255, Math.round(result[i] * 255)))
    }
    return { pixels: out, width: w, height: h }
  }

  destroy() {
    this.device.destroy()
  }
}
