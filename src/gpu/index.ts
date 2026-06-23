// Preprocessing dispatcher. WebGPU-first with a Canvas fallback.
//
// Routes to the WebGPU compute pipeline when available; otherwise (or on any GPU
// error) falls back to the Canvas path. Both return identical { pixels, w, h }.

import type { PixelData } from '../lib/params'
import { decodeImage, preprocessCanvas, type PreprocessOptions } from './cpu-fallback'
import { WebGPUPreprocessor } from './webgpu-preprocessor'

export type PreprocessBackend = 'webgpu' | 'canvas'

let cachedGpuAvailable: boolean | null = null
let gpuPreprocessor: WebGPUPreprocessor | null = null
let gpuInitTried = false

/** Feature-detect WebGPU (cached). Safe to call repeatedly. */
export async function isWebGPUAvailable(): Promise<boolean> {
  if (cachedGpuAvailable !== null) return cachedGpuAvailable
  try {
    if (!('gpu' in navigator) || !navigator.gpu) {
      cachedGpuAvailable = false
    } else {
      const adapter = await navigator.gpu.requestAdapter()
      cachedGpuAvailable = !!adapter
    }
  } catch {
    cachedGpuAvailable = false
  }
  return cachedGpuAvailable
}

async function getGpuPreprocessor(): Promise<WebGPUPreprocessor | null> {
  if (gpuInitTried) return gpuPreprocessor
  gpuInitTried = true
  try {
    gpuPreprocessor = await WebGPUPreprocessor.create()
  } catch {
    gpuPreprocessor = null
  }
  return gpuPreprocessor
}

export interface PreprocessResult extends PixelData {
  backend: PreprocessBackend
  durationMs: number
}

/**
 * Decode + preprocess an image into RGBA pixels ready for the tracer.
 * Tries WebGPU first; falls back to Canvas on unavailability or error.
 */
export async function preprocess(file: Blob, opts: PreprocessOptions): Promise<PreprocessResult> {
  const t0 = performance.now()
  const bitmap = await decodeImage(file)
  try {
    const gpu = await getGpuPreprocessor()
    if (gpu) {
      try {
        const result = await gpu.process(bitmap, opts)
        return { ...result, backend: 'webgpu', durationMs: performance.now() - t0 }
      } catch (err) {
        // GPU path failed mid-run — degrade to Canvas rather than erroring.
        console.warn('WebGPU preprocessing failed, falling back to Canvas:', err)
      }
    }
    const result = preprocessCanvas(bitmap, opts)
    return { ...result, backend: 'canvas', durationMs: performance.now() - t0 }
  } finally {
    bitmap.close()
  }
}

export { decodeImage, preprocessCanvas } from './cpu-fallback'
export { DEFAULT_PREPROCESS } from './cpu-fallback'
export type { PreprocessOptions, ThresholdMode } from './cpu-fallback'
