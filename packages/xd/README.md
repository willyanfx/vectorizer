# @vector/xd

Adobe XD (`.xd`) → SVG, with a layer tree, in the browser. Comes in two
implementations that produce **byte-identical** output:

- **TypeScript** — this package (`packages/xd`), used by the app.
- **Rust** — `crates/xd-core`, with WebAssembly bindings in `crates/xd-wasm`.

```ts
import { parseXd, composeArtboard } from '@vector/xd'

const doc = await parseXd(file, { imageScale: 2 })
const { svg } = composeArtboard(doc, doc.artboards[0], { hidden: new Set(['xl3']) })
```

| Module | What |
| --- | --- |
| `parse.ts` | `parseXd`, `setXdImageScale`, `isXdFile`, `toDisplaySvg` |
| `render/` | `.agc` scene graph → SVG (shapes, text, groups, components, artboards) |
| `images.ts` | embedded images: placeholders + downscaled data URIs |
| `compose.ts` | hide layers / export only some layers, cropped |
| `layers.ts` | layer-tree helpers and canvas selection (`pickLayer`, `toggleLayer`) |
| `dom.ts` | browser-only measuring (`visibleRect`) |

Parsing runs anywhere with `File`/`Blob` (browser, Node ≥ 20). Composing and
measuring need a live DOM.

## Rust / WebAssembly

`xd-core` ports everything up to the rendered document: artboards, SVG,
templates, layer tree, image placeholders, image downscaling (`image` crate),
and the embedded preview. `xd-wasm` exposes it to JavaScript:

```ts
import { parseXd, processImages, fillImages, listArtboards } from 'xd-wasm' // crates/xd-wasm/pkg

const doc = parseXd(new Uint8Array(await file.arrayBuffer()), 2)
// doc.artboards has the same shape as @vector/xd's XdArtboard, so
// composeArtboard / pickLayer / walkLayers work on it unchanged.
```

What stays TypeScript-only, because it needs a DOM:

- `composeArtboard*` and `visibleRect` (layer cropping and hit boxes).
- The tie-breaker for old files whose layers sit in pasteboard coordinates.
  Both versions vote on layer positions; when the vote is a tie, the browser
  build of the TS renderer measures the content, while Rust (and TS in Node)
  keep artboard-local coordinates.

`imageScale` downscaling uses canvas in the browser and the `image` crate in
Rust, so re-encoded images are not byte-identical between the two. Everything
else is.

## Tests

```sh
npm run test:xd          # TS: unit + golden tests (vitest)
npm run test:xd-rust     # Rust: unit + golden tests (cargo)
npm run test:xd-wasm     # builds the Node WASM package, then runs the TS suite
                         # including WASM-vs-TS checks (test/wasm.test.ts)
npm run build:xd-wasm    # bundler build → crates/xd-wasm/pkg
```

**Golden fixtures** (`test/fixtures/*.xd` + `*.expected.json`) are built by
`test/fixture.ts` and rendered by this package. The Rust golden test reads the
same files, so any rendering change must land in both implementations. After
an intended change to the TS renderer or the fixtures:

```sh
npm run golden -w @vector/xd   # rewrite fixtures + expected output
npm run test:xd-rust           # then make the Rust port match
```

Keep each Rust module in step with its TS counterpart
(`render/context.rs` ↔ `render/context.ts`, …). `crates/xd-core/src/js.rs`
reproduces the JavaScript behaviour the renderer relies on: number formatting,
`Math.round`, truthiness, and UTF-16 string indexing for XD's text ranges.
