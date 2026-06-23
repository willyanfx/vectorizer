# Vector — raster → SVG in your browser

A fully client-side single-page app that converts uploaded raster images
(PNG/JPG/WebP/GIF/BMP) into SVG vectors with rich, tunable parameters.
Everything runs in the browser — **your images never leave your device.**

<a href="https://www.buymeacoffee.com/willyanfx" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="48" width="174"></a>

- **Tracing:** [VTracer](https://github.com/visioncortex/vtracer) (Rust → WASM)
  for high-quality color/binary tracing, run in a **Web Worker** so the UI stays
  responsive. Automatic fallback to
  [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) (pure JS)
  when WebAssembly is unavailable.
- **Preprocessing:** **WebGPU** compute shaders (blur + quantize) clean up the
  image before tracing for better results, with a **Canvas 2D** fallback that
  works everywhere (including iOS Safari).
- **Preview:** side-by-side / split / overlay views with smooth, crisp,
  resolution-independent zoom & pan.
- **Export:** download the SVG, or an SVGO-optimized version.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173/vectorizer/
```

> Note the `/vectorizer/` path — `base` is set for GitHub Pages project hosting.

## Build

```bash
npm run build    # → dist/
npm run preview  # serve the production build locally
```

## Deploy (GitHub Pages)

1. The repo is named **`vectorizer`** and `base` in `vite.config.ts` is set to
   `/vectorizer/` to match (they must match for project Pages hosting).
2. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and
   publishes automatically.
3. In the repo: **Settings → Pages → Source → "GitHub Actions"**.
4. Open `https://willyanfx.github.io/vectorizer/`.

### Hosting elsewhere (e.g. Vercel, root domain)

Build with a root base path:

```bash
VITE_BASE=/ npm run build
```

## How it works

```
upload → decode (Canvas) → preprocess (WebGPU ▸ Canvas fallback)
       → Web Worker: VTracer WASM ▸ imagetracerjs fallback
       → SVG → preview + download
```

## Tech

React 19 · TypeScript · Vite · vite-plugin-wasm · WebGPU · Web Workers · SVGO

## License

MIT
