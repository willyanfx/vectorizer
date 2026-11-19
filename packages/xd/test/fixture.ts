// Synthetic .xd archives, shaped like the files XD writes: manifest + shared
// resources + one scene graph per artboard. `npm run golden -w @vector/xd`
// writes them to test/fixtures/ together with the expected render output,
// which both the TS tests and the Rust port (crates/xd-core) check against.

import { crc32, deflateSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'

const json = (v: unknown) => strToU8(JSON.stringify(v))
const zip = (files: Record<string, Uint8Array>) => zipSync(files, { mtime: new Date(2024, 0, 1) })

export const ARTBOARD = { id: 'artboard-A1', name: 'Home', width: 375, height: 812 }

export function basicXd(opts: { manifest?: boolean } = {}): Uint8Array {
  const { manifest = true } = opts
  const files: Record<string, Uint8Array> = {
    'resources/graphics/graphicContent.agc': json({
      artboards: { [ARTBOARD.id]: { x: 0, y: 0, width: ARTBOARD.width, height: ARTBOARD.height } },
      resources: { gradients: {}, clipPaths: {} },
    }),
    [`artwork/${ARTBOARD.id}/graphics/graphicContent.agc`]: json({
      children: [
        {
          type: 'artboard',
          artboard: {
            ref: ARTBOARD.id,
            children: [
              {
                type: 'shape',
                name: 'Card',
                transform: { a: 1, b: 0, c: 0, d: 1, tx: 16, ty: 24 },
                shape: { type: 'rect', x: 0, y: 0, width: 343, height: 120, r: [8, 8, 8, 8] },
                style: { fill: { type: 'solid', color: { value: { r: 255, g: 0, b: 0 } } } },
              },
              {
                type: 'group',
                name: 'Header',
                group: {
                  children: [
                    {
                      type: 'text',
                      transform: { tx: 20, ty: 60 },
                      text: {
                        rawText: 'Hello world',
                        frame: { type: 'positioned' },
                        paragraphs: [{ lines: [[{ x: 0, y: 0, from: 0, to: 11 }]] }],
                      },
                      style: {
                        font: { family: 'Inter', style: 'Bold', size: 24 },
                        fill: { type: 'solid', color: { value: { r: 0, g: 0, b: 0 } } },
                      },
                      meta: { ux: { rangedStyles: [{ length: 11, textTransform: 'uppercase' }] } },
                    },
                    { type: 'mystery' },
                  ],
                },
              },
            ],
          },
          style: { fill: { type: 'solid', color: { value: { r: 255, g: 255, b: 255 } } } },
        },
      ],
    }),
  }
  if (manifest) {
    files.manifest = json({
      children: [{ name: 'artwork', children: [{ path: ARTBOARD.id, name: ARTBOARD.name }] }],
    })
  }
  return zip(files)
}

/* ------------------------------------------------------------ kitchen sink */

/** Minimal RGBA PNG encoder (enough for fixtures). */
export function png(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) {
  const chunk = (type: string, data: Uint8Array) => {
    const td = new Uint8Array([...strToU8(type), ...data])
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(td, 4)
    dv.setUint32(8 + data.length, crc32(td))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (1 + w * 4) + 1 + x * 4)
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const rgb = (r: number, g: number, b: number, alpha?: number) => ({
  value: { r, g, b },
  ...(alpha == null ? {} : { alpha }),
})
const solid = (r: number, g: number, b: number, alpha?: number) => ({ type: 'solid', color: rgb(r, g, b, alpha) })
const at = (tx: number, ty: number) => ({ a: 1, b: 0, c: 0, d: 1, tx, ty })
const black = { fill: solid(0, 0, 0) }

/** One line of text per entry: [x, y, from, to]. */
const lines = (...ls: Array<Array<[number, number, number, number]>>) => [
  { lines: ls.map((l) => l.map(([x, y, from, to]) => ({ x, y, from, to }))) },
]

const SHAPES = [
  {
    type: 'shape',
    name: 'Mixed corners',
    transform: at(10, 10),
    shape: { type: 'rect', x: 0, y: 0, width: 120, height: 60, r: [4, 8, 0, 100] },
    style: {
      fill: solid(10, 20, 30, 0.5),
      stroke: { type: 'solid', color: rgb(255, 0, 0, 0.25), width: 2, cap: 'round', join: 'bevel', miterLimit: 3, dash: [4, 2.5] },
      opacity: 0.8,
      blendMode: 'multiply',
    },
  },
  {
    type: 'shape',
    name: 'Linear',
    transform: { a: 0.7071, b: 0.7071, c: -0.7071, d: 0.7071, tx: 200, ty: 20 },
    shape: { type: 'ellipse', cx: 30, cy: 20, rx: 30, ry: 20 },
    style: {
      fill: {
        type: 'gradient',
        gradient: { ref: 'grad-lin', x1: 0, y1: 0, x2: 1, y2: 1, gradientTransform: { a: 2, d: 0.5, tx: 1 } },
      },
    },
  },
  {
    type: 'shape',
    transform: at(300, 20),
    shape: { type: 'circle', cx: 25, cy: 25, r: 25 },
    style: {
      fill: {
        type: 'gradient',
        gradient: {
          units: 'userSpaceOnUse',
          cx: 25,
          cy: 25,
          r: 25,
          fx: 20,
          fy: 18,
          meta: { ux: { gradientResources: { stops: [{ offset: 0, color: rgb(255, 255, 0) }, { offset: 1, color: rgb(0, 0, 255, 0.3) }] } } },
        },
      },
      stroke: { type: 'gradient', width: 1.5, gradient: { ref: 'grad-lin' } },
    },
  },
  {
    type: 'shape',
    name: 'Rule',
    shape: { type: 'line', x1: 0, y1: 100, x2: 380, y2: 100 },
    style: { stroke: { type: 'solid', color: rgb(200, 200, 200), width: 1 } },
  },
  {
    type: 'shape',
    name: 'Triangle',
    transform: at(20, 110),
    shape: { type: 'polygon', points: [{ x: 0, y: 40 }, { x: 20, y: 0 }, { x: 40, y: 40 }] },
    style: { fill: solid(0, 128, 0) },
  },
  {
    type: 'shape',
    name: 'Ring',
    transform: at(80, 110),
    shape: { type: 'path', path: 'M0 20A20 20 0 1 0 40 20A20 20 0 1 0 0 20ZM10 20A10 10 0 1 0 30 20A1e1 1e1 0 1 0 10 20Z', fillRule: 'evenodd' },
    style: { fill: solid(128, 0, 128) },
  },
  {
    type: 'shape',
    name: 'Photo',
    transform: at(140, 110),
    shape: { type: 'rect', x: 0, y: 0, width: 80, height: 60, r: 6 },
    style: {
      fill: { type: 'pattern', pattern: { width: 16, height: 16, meta: { ux: { uid: 'img1', scaleBehavior: 'fill' } } } },
      stroke: { type: 'solid', color: rgb(0, 0, 0), width: 1 },
    },
  },
  {
    type: 'shape',
    name: 'Blob photo',
    transform: at(230, 110),
    shape: { type: 'path', path: 'M0 0L50 0L50 40L0 40Z' },
    style: { fill: { type: 'pattern', pattern: { width: 8, height: 8, href: '/img2' } } },
  },
  {
    type: 'shape',
    name: 'Missing image',
    shape: { type: 'rect', x: 290, y: 110, width: 20, height: 20 },
    style: { fill: { type: 'pattern', pattern: { meta: { ux: { uid: 'nope' } } } } },
  },
  {
    type: 'shape',
    name: 'Vector image',
    shape: { type: 'rect', x: 320, y: 110, width: 20, height: 20 },
    style: { fill: { type: 'pattern', pattern: { meta: { ux: { uid: 'vec1' } } } } },
  },
  { type: 'shape', name: 'Broken', shape: { type: 'path' } },
  { type: 'boolean', name: 'Union', shape: { type: 'compound', path: 'M0 200L10 210L0 220Z' }, style: black },
]

const TEXT = [
  {
    type: 'text',
    name: 'Centered area',
    transform: at(20, 240),
    text: {
      rawText: 'Centered line one  \nsecond   ',
      frame: { type: 'area', width: 200, height: 80 },
      paragraphs: [
        ...lines([[12.5, 20, 0, 19]]),
        ...lines([[60, 44, 20, 30]]),
      ],
    },
    style: {
      font: { family: 'Sharp Grotesk Bold', style: '19', postscriptName: 'SharpGroteskBold19', size: 18 },
      fill: solid(17, 17, 17),
      textAttributes: { paragraphAlign: 'center', letterSpacing: 50 },
    },
  },
  {
    type: 'text',
    transform: at(200, 240),
    text: { rawText: 'Auto center', frame: { type: 'autoHeight', width: 120 }, paragraphs: lines([[-40, 16, 0, 11]]) },
    style: { font: { family: 'Inter', style: 'Medium Italic', size: 14 }, ...black, textAttributes: { paragraphAlign: 'center' } },
  },
  {
    type: 'text',
    transform: at(380, 270),
    text: { rawText: 'Right', frame: { type: 'positioned' }, paragraphs: lines([[-40, 0, 0, 5]]) },
    style: { font: { family: 'Inter', size: 12 }, ...black, textAttributes: { paragraphAlign: 'right' } },
  },
  {
    type: 'text',
    name: 'Mixed runs',
    transform: at(20, 320),
    text: {
      rawText: 'Bold, red & <plain> text',
      frame: { type: 'positioned' },
      paragraphs: [{ lines: [[{ x: 0, y: 0, from: 0, to: 11, style: { font: { family: 'Inter', style: 'Black' }, fill: { color: rgb(0, 0, 0) } } }, { x: 80, y: 0, from: 11, to: 24 }]] }],
    },
    style: { font: { family: 'Inter', size: 16 }, ...black, textAttributes: { letterSpacing: 10 } },
    meta: {
      ux: {
        rangedStyles: [
          { length: 5, fontFamily: 'Inter', fontStyle: 'Extra Bold', fontSize: 16, fill: { value: -65536 }, charSpacing: 10, underline: true },
          { length: 6, fontFamily: 'Inter', fontSize: 16, fill: rgb(255, 0, 0), charSpacing: 20, strikethrough: true },
          { length: 4, fontFamily: 'Inter', fontSize: 12, fill: { value: 0x80336699 }, textTransform: 'titlecase' },
        ],
      },
    },
  },
  {
    type: 'text',
    transform: at(20, 360),
    text: { rawText: 'no layout\r\nsecond\rthird\nfourth' },
    style: { font: { family: 'Inter', size: 10 }, ...black, textAttributes: { lineHeight: 14 } },
  },
  {
    type: 'text',
    transform: at(200, 360),
    text: { rawText: 'title case, émigré words', paragraphs: lines([[0, 0, 0, 24]]) },
    style: { font: { family: 'Inter', size: 10 }, ...black },
    meta: { ux: { rangedStyles: [{ length: 24, textTransform: 'titlecase' }] } },
  },
  {
    type: 'text',
    transform: at(20, 440),
    text: { rawText: 'Straße', paragraphs: lines([[0, 0, 0, 6]]) },
    style: { font: { family: 'Inter', size: 10 }, ...black },
    meta: { ux: { rangedStyles: [{ length: 6, textTransform: 'uppercase' }] } },
  },
  {
    type: 'text',
    transform: at(120, 440),
    text: { rawText: 'Emoji 😀 ok then', paragraphs: lines([[0, 0, 0, 9], [0, 12, 9, 16]]) },
    style: { font: { family: 'Inter', size: 10 }, fill: solid(0, 0, 0, 0.6) },
    meta: { ux: { rangedStyles: [{ length: 6, textTransform: 'lowercase' }, { length: 3, fontSize: 20 }] } },
  },
  { type: 'text', name: 'Empty text', text: { rawText: '' }, style: black },
]

const GROUPS = [
  {
    type: 'group',
    name: 'Masked shadows',
    transform: at(20, 480),
    style: {
      clipPath: { ref: 'clip-1' },
      filters: [
        { type: 'dropShadow', params: { dropShadowList: [{ dx: 0, dy: 3, r: 6, color: rgb(0, 0, 0, 0.16) }, { dx: 1, dy: 1, r: 1, color: rgb(255, 0, 0) }] } },
        { type: 'uxdesign#blur', params: { blurAmount: 4 } },
        { type: 'uxdesign#blur', params: { blurAmount: 9, backgroundEffect: true } },
        { type: 'dropShadow', visible: false, params: { dropShadowList: [{ dx: 9, dy: 9, r: 9, color: rgb(0, 0, 0) }] } },
      ],
    },
    group: {
      children: [
        { type: 'shape', shape: { type: 'rect', x: 0, y: 0, width: 100, height: 100 }, style: { fill: solid(240, 240, 240) } },
        { type: 'shape', name: 'Hidden', visible: false, shape: { type: 'rect', width: 10, height: 10 }, style: black },
      ],
    },
  },
  {
    type: 'group',
    name: 'Scroller',
    transform: at(140, 480),
    meta: {
      ux: {
        scrollingType: 'vertical',
        viewportHeight: 120,
        clipPathResources: { children: [{ shape: { type: 'rect', x: 0, y: 0, width: 200, height: 300 }, transform: at(0, 0) }] },
      },
    },
    group: {
      children: [
        { type: 'shape', shape: { type: 'rect', width: 200, height: 300 }, style: { fill: solid(0, 0, 255) } },
      ],
    },
  },
  {
    type: 'group',
    name: 'Sideways',
    transform: at(20, 620),
    meta: { ux: { scrollingType: 'horizontal', viewportWidth: 80 } },
    group: { children: [{ type: 'shape', shape: { type: 'ellipse', cx: 50, cy: 10, rx: 50, ry: 10 }, style: black }] },
  },
  {
    type: 'group',
    transform: { a: 0.5, b: 0, c: 0, d: 0.5, tx: 200, ty: 620 },
    group: {
      children: [
        {
          type: 'text',
          text: { rawText: '  A text layer   whose name is much longer than forty-eight characters  ', paragraphs: lines([[0, 0, 0, 40]]) },
          style: { font: { family: 'Inter', size: 10 }, ...black },
        },
      ],
    },
  },
  { type: 'repeatGrid', name: 'Grid', children: [{ type: 'shape', shape: { type: 'circle', cx: 5, cy: 5, r: 5 }, style: black }] },
  { type: 'mystery', name: 'Unknown' },
]

const COMPONENTS = [
  {
    type: 'syncRef',
    name: 'Primary',
    syncSourceGuid: 'sym-btn',
    transform: at(20, 700),
    group: {
      children: [
        { type: 'shape', shape: { type: 'rect', width: 120, height: 40, r: 20 }, style: { fill: solid(0, 102, 255) } },
        { type: 'text', text: { rawText: 'Buy now', paragraphs: lines([[30, 25, 0, 7]]) }, style: { font: { family: 'Inter', style: 'Semibold', size: 14 }, fill: solid(255, 255, 255) } },
      ],
    },
  },
  { type: 'syncRef', name: 'Star copy', syncSourceGuid: 'pb-star', transform: at(160, 700), style: { opacity: 0.5 } },
  { type: 'syncRef', syncSourceGuid: 'sym-alias', transform: at(260, 700) },
  { type: 'syncRef', name: 'Orphan', syncSourceGuid: 'does-not-exist' },
  { type: 'syncRef', syncSourceGuid: 'sym-btn', visible: false },
]

export function kitchenSinkXd(): Uint8Array {
  const img1 = png(4, 3, (x, y) => [x * 60, y * 80, 200, x === 0 ? 128 : 255])
  const jpegish = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0])
  return zip({
    mimetype: strToU8('application/vnd.adobe.sparkler.project+dcxucf'),
    manifest: json({
      name: 'Kitchen sink',
      children: [
        {
          name: 'artwork',
          children: [
            { path: 'pasteboard', name: 'pasteboard' },
            { path: 'artboard-K1', name: 'Kitchen <sink> & "co"' },
            { path: 'artboard-K2', name: 'Pasteboard coords' },
            { path: 'artboard-K3', name: 'Legacy', 'uxdesign#bounds': { x: 0, y: 0, width: 320, height: 200 } },
            { path: 'artboard-missing', name: 'Not in archive' },
          ],
        },
      ],
    }),
    'resources/graphics/graphicContent.agc': json({
      artboards: {
        'artboard-K1': { x: 0, y: 0, width: 400, height: 900 },
        K2: { x: 1000, y: 200, width: 200, height: 150 },
      },
      resources: {
        gradients: {
          'grad-lin': { type: 'linear', stops: [{ offset: 0, color: rgb(255, 0, 0) }, { offset: 0.333333, color: rgb(0, 255, 0, 0.5) }, { offset: 1, color: rgb(0, 0, 255) }] },
        },
        clipPaths: {
          'clip-1': { children: [{ shape: { type: 'ellipse', cx: 50, cy: 50, rx: 50, ry: 50 }, transform: at(0, 0) }, { shape: { type: 'path', path: 'M0 0L10 10' } }] },
        },
        meta: {
          ux: {
            symbols: [
              {
                id: 'sym-btn',
                type: 'group',
                name: 'Button',
                style: { opacity: 0.9 },
                group: {
                  children: [
                    { id: 'sym-btn-bg', type: 'shape', shape: { type: 'rect', width: 120, height: 40, r: 20 }, style: { fill: solid(0, 0, 0) } },
                    { id: 'sym-btn-label', type: 'text', text: { rawText: 'Button' }, style: { font: { family: 'Inter', size: 14 }, fill: solid(255, 255, 255) } },
                  ],
                },
              },
              { id: 'sym-alias', type: 'syncRef', syncSourceGuid: 'sym-btn', name: 'Alias' },
            ],
          },
        },
      },
    }),
    'artwork/pasteboard/graphics/graphicContent.agc': json({
      children: [
        {
          id: 'pb-star',
          type: 'shape',
          name: 'Star',
          shape: { type: 'polygon', points: [{ x: 10, y: 0 }, { x: 13, y: 7 }, { x: 20, y: 7 }, { x: 14, y: 12 }, { x: 16, y: 20 }, { x: 10, y: 15 }, { x: 4, y: 20 }, { x: 6, y: 12 }, { x: 0, y: 7 }, { x: 7, y: 7 }], path: 'M10 0L13 7L20 7L14 12L16 20L10 15L4 20L6 12L0 7L7 7Z' },
          style: { fill: solid(255, 200, 0) },
        },
      ],
    }),
    'artwork/artboard-K1/graphics/graphicContent.agc': json({
      children: [
        {
          type: 'artboard',
          artboard: { ref: 'artboard-K1', children: [...SHAPES, ...TEXT, ...GROUPS, ...COMPONENTS] },
          style: { fill: solid(250, 250, 250, 0.5) },
        },
      ],
    }),
    'artwork/artboard-K2/graphics/graphicContent.agc': json({
      children: [
        {
          type: 'artboard',
          artboard: {
            ref: 'K2',
            children: [
              { type: 'shape', transform: at(1010, 210), shape: { type: 'rect', width: 50, height: 50 }, style: black },
              { type: 'shape', transform: at(1100, 250), shape: { type: 'circle', cx: 10, cy: 10, r: 10 }, style: black },
              { type: 'shape', transform: at(5, 5), shape: { type: 'rect', width: 5, height: 5 }, style: black },
            ],
          },
          style: { fill: { type: 'none', color: rgb(1, 2, 3) } },
        },
      ],
    }),
    'artwork/artboard-K3/graphics/graphicContent.agc': json({
      children: [{ type: 'shape', name: 'Loose', shape: { type: 'rect', width: 30, height: 30 }, style: { fill: { color: rgb(9, 9, 9) } } }],
    }),
    'resources/img1': img1,
    'resources/img2': jpegish,
    'resources/vec1': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'preview.png': png(2, 2, () => [255, 0, 0, 255]),
  })
}

/** Fixtures written to test/fixtures/<name>.xd with golden output. */
export const FIXTURES: Record<string, () => Uint8Array> = {
  basic: () => basicXd(),
  'no-manifest': () => basicXd({ manifest: false }),
  'kitchen-sink': kitchenSinkXd,
}
