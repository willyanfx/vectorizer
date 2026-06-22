// VTracer config + the worker message protocol.
//
// IMPORTANT: the WASM `to_svg` deserializes a Rust struct with serde
// `rename_all = "camelCase"`. ALL fields are required (no #[serde(default)],
// no Option) — a missing field makes the Rust `from_value::<Config>().unwrap()`
// panic. So `toVTracerConfig()` must always emit every key.
//
// Source of truth: https://github.com/jsscheller/vtracer-wasm src/lib.rs
//   binary: bool, mode, hierarchical, cornerThreshold, lengthThreshold,
//   maxIterations, spliceThreshold, filterSpeckle, colorPrecision,
//   layerDifference, pathPrecision

export type ColorMode = 'color' | 'binary'
export type Hierarchical = 'stacked' | 'cutout'
export type CurveMode = 'spline' | 'polygon' | 'pixel'

/** UI-facing parameter shape (what the controls bind to). */
export interface TraceParams {
  colorMode: ColorMode
  hierarchical: Hierarchical
  mode: CurveMode
  filterSpeckle: number // [0, 128]   default 4   (discard patches < N px)
  colorPrecision: number // [1, 8]    default 6   (significant bits per channel)
  layerDifference: number // [0, 128] default 16  (color diff between layers)
  cornerThreshold: number // [0, 180] default 60  (degrees)
  lengthThreshold: number // [3.5, 10] default 4  (float)
  spliceThreshold: number // [0, 180] default 45  (degrees)
  pathPrecision: number // [0, 8]     default 8   (decimal places in path)
  maxIterations: number // [1, 70]    default 10  (curve fitting iterations)
}

export const DEFAULT_PARAMS: TraceParams = {
  colorMode: 'color',
  hierarchical: 'stacked',
  mode: 'spline',
  filterSpeckle: 4,
  colorPrecision: 6,
  layerDifference: 16,
  cornerThreshold: 60,
  lengthThreshold: 4,
  spliceThreshold: 45,
  pathPrecision: 8,
  maxIterations: 10,
}

/** The exact object shape the WASM expects (camelCase, every field present). */
export interface VTracerConfig {
  binary: boolean
  mode: CurveMode
  hierarchical: Hierarchical
  cornerThreshold: number
  lengthThreshold: number
  maxIterations: number
  spliceThreshold: number
  filterSpeckle: number
  colorPrecision: number
  layerDifference: number
  pathPrecision: number
}

export function toVTracerConfig(p: TraceParams): VTracerConfig {
  return {
    binary: p.colorMode === 'binary',
    mode: p.mode,
    hierarchical: p.hierarchical,
    cornerThreshold: p.cornerThreshold,
    lengthThreshold: p.lengthThreshold,
    maxIterations: p.maxIterations,
    spliceThreshold: p.spliceThreshold,
    filterSpeckle: p.filterSpeckle,
    colorPrecision: p.colorPrecision,
    layerDifference: p.layerDifference,
    pathPrecision: p.pathPrecision,
  }
}

// ---- Presets -------------------------------------------------------------

export interface Preset {
  name: string
  description: string
  params: Partial<TraceParams>
}

export const PRESETS: Preset[] = [
  {
    name: 'Photo',
    description: 'Full color, smooth splines, many layers',
    params: {
      colorMode: 'color',
      hierarchical: 'stacked',
      mode: 'spline',
      filterSpeckle: 4,
      colorPrecision: 7,
      layerDifference: 12,
    },
  },
  {
    name: 'Flat illustration',
    description: 'Bold flat colors, fewer layers, clean edges',
    params: {
      colorMode: 'color',
      hierarchical: 'stacked',
      mode: 'spline',
      filterSpeckle: 8,
      colorPrecision: 5,
      layerDifference: 24,
    },
  },
  {
    name: 'Line art',
    description: 'Black & white, sharp polygons',
    params: {
      colorMode: 'binary',
      hierarchical: 'cutout',
      mode: 'polygon',
      filterSpeckle: 4,
      cornerThreshold: 80,
    },
  },
  {
    name: 'Pixel',
    description: 'Preserve hard pixel edges',
    params: {
      colorMode: 'color',
      mode: 'pixel',
      filterSpeckle: 0,
    },
  },
]

// ---- Worker message protocol --------------------------------------------

export type TraceEngine = 'vtracer' | 'imagetracer'

/** Raw RGBA pixels + dimensions, ready for the tracer. */
export interface PixelData {
  pixels: Uint8Array // RGBA, length = width * height * 4
  width: number
  height: number
}

export type WorkerRequest =
  | { type: 'init' }
  | {
      type: 'trace'
      id: number
      pixels: Uint8Array
      width: number
      height: number
      config: VTracerConfig
    }

export type WorkerResponse =
  | { type: 'ready'; engine: TraceEngine }
  | { type: 'fallback'; reason: string }
  | { type: 'result'; id: number; svg: string; durationMs: number; engine: TraceEngine }
  | { type: 'error'; id: number; message: string }
