/// <reference lib="webworker" />
//
// Tracer worker. Runs the heavy WASM (vtracer) off the main thread.
//
// CRITICAL: vtracer-wasm's default init resolves `new URL('vtracer_bg.wasm',
// import.meta.url)` but the package actually ships `vtracer.wasm`. So we never
// rely on the default — we import the real binary via Vite's `?url` and pass it
// explicitly to init(). If init throws for any reason, we fall back to the pure
// JS imagetracerjs so the app still produces an SVG everywhere.

import init, { to_svg } from 'vtracer-wasm'
import wasmUrl from 'vtracer-wasm/vtracer.wasm?url'
// imagetracerjs is UMD (`module.exports = new ImageTracer()`); Vite interops it
// as a default import. `imagedataToSVG({data,width,height}, options)` is sync.
import ImageTracer from 'imagetracerjs'
import type { WorkerRequest, WorkerResponse, VTracerConfig, TraceEngine } from '../lib/params'

let engine: TraceEngine | null = null

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  ;(self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? [])
}

async function initEngine() {
  try {
    await init({ module_or_path: wasmUrl })
    engine = 'vtracer'
    post({ type: 'ready', engine })
  } catch (err) {
    engine = 'imagetracer'
    post({ type: 'fallback', reason: err instanceof Error ? err.message : String(err) })
    post({ type: 'ready', engine })
  }
}

// Map our VTracer config onto imagetracerjs options as best we can. The two
// engines are not equivalent; this just keeps the fallback reasonable.
function imageTracerOptions(config: VTracerConfig) {
  // Binary + sharp corners + fine speckle is our "Text" profile. When it's
  // active, tune imagetracerjs for glyphs: keep every short stroke segment
  // (pathomit 0), fit lines/curves precisely (low ltres/qtres), no blur.
  const textProfile = config.binary && config.mode === 'polygon' && config.filterSpeckle <= 2
  if (textProfile) {
    return {
      numberofcolors: 2,
      pathomit: 0, // thin strokes are short paths — never discard
      ltres: 0.5, // precise straight-line fitting
      qtres: 0.5, // precise quadratic-spline fitting
      roundcoords: Math.max(0, Math.min(config.pathPrecision, 8)),
      rightangleenhance: true, // sharpen right-angle corners
      linefilter: true,
      blurradius: 0,
      colorquantcycles: 1,
    }
  }
  return {
    // imagetracerjs uses a fixed palette size; approximate from colorPrecision.
    numberofcolors: config.binary ? 2 : Math.max(2, 2 ** Math.min(config.colorPrecision, 6)),
    pathomit: config.filterSpeckle, // drop short paths ~ filter speckle
    ltres: config.mode === 'polygon' ? 100 : 1, // high ltres ≈ straight lines
    qtres: 1,
    roundcoords: Math.max(0, Math.min(config.pathPrecision, 8)),
    linefilter: true,
    colorquantcycles: 3,
  }
}

function traceWithImageTracer(pixels: Uint8Array, width: number, height: number, config: VTracerConfig): string {
  // imagetracerjs expects a Uint8ClampedArray-backed ImageData-like object.
  const imgd = { data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length), width, height }
  return ImageTracer.imagedataToSVG(imgd, imageTracerOptions(config))
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'init') {
    await initEngine()
    return
  }

  if (msg.type === 'trace') {
    const { id, pixels, width, height, config } = msg
    const t0 = performance.now()
    try {
      let svg: string
      if (engine === 'vtracer') {
        svg = to_svg(pixels, width, height, config)
      } else if (engine === 'imagetracer') {
        svg = traceWithImageTracer(pixels, width, height, config)
      } else {
        throw new Error('Tracer not initialized')
      }
      post({ type: 'result', id, svg, durationMs: performance.now() - t0, engine })
    } catch (err) {
      post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
