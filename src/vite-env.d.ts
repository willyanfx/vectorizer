/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

// Vite emits the bytes and gives us a runtime URL string.
declare module '*.wasm?url' {
  const url: string
  export default url
}

// WGSL shaders imported as raw source strings (`?raw`).
declare module '*.wgsl?raw' {
  const src: string
  export default src
}

// imagetracerjs is UMD with `module.exports = new ImageTracer()`. We only use
// `imagedataToSVG`. Declared loosely since the package ships no types.
declare module 'imagetracerjs' {
  interface ImageDataLike {
    data: Uint8ClampedArray
    width: number
    height: number
  }
  interface ImageTracerInstance {
    imagedataToSVG(imgd: ImageDataLike, options?: Record<string, unknown>): string
  }
  const tracer: ImageTracerInstance
  export default tracer
}

// vtracer-wasm ships its own .d.ts (to_svg, default init). No declaration needed.

// SVGO browser subpath build. Re-uses SVGO's own optimize type signature.
declare module 'svgo/browser' {
  export { optimize } from 'svgo'
}
