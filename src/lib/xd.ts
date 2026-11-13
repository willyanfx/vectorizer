// Adobe XD (.xd) → SVG, fully in the browser.
//
// A local .xd file is a ZIP archive. The parts we care about:
//   manifest                                       JSON: artboard list (names, bounds)
//   artwork/artboard-<id>/graphics/graphicContent.agc   JSON scene graph per artboard
//   resources/graphics/graphicContent.agc          JSON: shared gradients, clip paths,
//                                                  artboard bounds
//   resources/<uid>                                raw image bytes (pattern fills)
//
// The .agc format is undocumented, so this renderer is deliberately defensive:
// it understands the common node types (shapes, groups, text, image fills,
// gradients, strokes, drop shadows, masks) and silently skips anything else,
// counting it in `skipped` so the UI can say the result may be incomplete.
//
// Cloud documents (saved to Creative Cloud, not as a local .xd) are not ZIPs
// and cannot be read here — the user must "Save As" a local file first.

import { unzip, type Unzipped } from 'fflate'

/* eslint-disable @typescript-eslint/no-explicit-any -- .agc is untyped JSON */
type Json = any

/** One entry in an artboard's layer tree (like the Layers panel in XD/Figma). */
export interface XdLayer {
  /** Id of the element in the artboard SVG (`<g id={key}>`). */
  key: string
  name: string
  kind: 'group' | 'shape' | 'image' | 'text' | 'component' | 'mask'
  children: XdLayer[]
}

export interface XdArtboard {
  id: string
  name: string
  width: number
  height: number
  /** Export SVG: fixed width/height so design tools keep the intended size. */
  svg: string
  /** Number of nodes the renderer did not understand and skipped. */
  skipped: number
  /** SVG with image placeholders, re-filled when the image scale changes. */
  template: string
  /** Top-level layers, top-most last (SVG paint order). */
  layers: XdLayer[]
}

export interface XdDocument {
  name: string
  artboards: XdArtboard[]
  /** Embedded raster preview, if the file has one (object URL). */
  previewUrl: string | null
  /** Current image scale (see ParseXdOptions.imageScale). */
  imageScale: number
  /** Image placeholder key → data URI at the current scale. */
  imageUris: Map<string, string>
  /** Original file + image sizes, so images can be re-processed at another scale. */
  source: { file: File; imageNeeds: Map<string, { w: number; h: number }> }
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const td = new TextDecoder()

function unzipAsync(data: Uint8Array, filter?: (name: string) => boolean): Promise<Unzipped> {
  return new Promise((resolve, reject) =>
    unzip(data, filter ? { filter: (f) => filter(f.name) } : {}, (err, files) =>
      err ? reject(err) : resolve(files),
    ),
  )
}

function readJson(files: Unzipped, path: string): Json | null {
  const bytes = files[path]
  if (!bytes) return null
  try {
    return JSON.parse(td.decode(bytes))
  } catch {
    return null
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  if (b[0] === 0x3c) return 'image/svg+xml' // '<'
  return null
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/* ------------------------------------------------------------------ colors */

function color(c: Json): { value: string; alpha: number } | null {
  if (!c) return null
  const v = c.value ?? c
  // Ranged text styles store colors as one ARGB integer.
  if (typeof v === 'number' && Number.isFinite(v)) {
    const hex = (v >>> 0).toString(16).padStart(8, '0')
    return { value: `#${hex.slice(2)}`, alpha: n(c.alpha, parseInt(hex.slice(0, 2), 16) / 255) }
  }
  if (v && typeof v === 'object' && 'r' in v) {
    const hex = [v.r, v.g, v.b]
      .map((x: number) => Math.max(0, Math.min(255, Math.round(n(x)))).toString(16).padStart(2, '0'))
      .join('')
    return { value: `#${hex}`, alpha: n(c.alpha, 1) }
  }
  return null
}

/* ----------------------------------------------------------- render context */

interface Ctx {
  files: Unzipped
  gradients: Record<string, Json>
  clipPaths: Record<string, Json>
  defs: string[]
  ids: number
  skipped: number
  /** Component masters + pasteboard nodes by id, for resolving syncRef instances. */
  symbols: Map<string, Json>
  /** Images referenced by this artboard: uid → largest displayed size (px). */
  imageNeeds: Map<string, { w: number; h: number }>
  depth: number
  layerIds: number
  /** Children list of the layer currently being rendered. */
  layerList: XdLayer[]
}

const uid = (ctx: Ctx, p: string) => `${p}${++ctx.ids}`

function transformAttr(t: Json): string {
  if (!t || typeof t !== 'object') return ''
  const { a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0 } = t
  if (a === 1 && b === 0 && c === 0 && d === 1) {
    return tx || ty ? ` transform="translate(${fmt(tx)} ${fmt(ty)})"` : ''
  }
  return ` transform="matrix(${[a, b, c, d, tx, ty].map((x) => fmt(n(x))).join(' ')})"`
}

function gradientDef(ctx: Ctx, g: Json): string | null {
  const res = ctx.gradients[g.ref] ?? g.meta?.ux?.gradientResources ?? null
  const stops: Json[] = res?.stops ?? []
  if (stops.length === 0) return null
  const id = uid(ctx, 'g')
  const units = g.units === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox'
  const stopXml = stops
    .map((s) => {
      const c = color(s.color)
      if (!c) return ''
      const op = c.alpha < 1 ? ` stop-opacity="${fmt(c.alpha)}"` : ''
      return `<stop offset="${fmt(n(s.offset))}" stop-color="${c.value}"${op}/>`
    })
    .join('')
  const gt = g.gradientTransform
    ? ` gradientTransform="matrix(${['a', 'b', 'c', 'd', 'tx', 'ty']
        .map((k) => fmt(n(g.gradientTransform[k], k === 'a' || k === 'd' ? 1 : 0)))
        .join(' ')})"`
    : ''
  if ((res?.type ?? g.type) === 'radial' || 'r' in g) {
    ctx.defs.push(
      `<radialGradient id="${id}" gradientUnits="${units}" cx="${fmt(n(g.cx, 0.5))}" cy="${fmt(n(g.cy, 0.5))}" r="${fmt(n(g.r, 0.5))}"${'fx' in g ? ` fx="${fmt(n(g.fx))}" fy="${fmt(n(g.fy))}"` : ''}${gt}>${stopXml}</radialGradient>`,
    )
  } else {
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="${units}" x1="${fmt(n(g.x1))}" y1="${fmt(n(g.y1))}" x2="${fmt(n(g.x2, 1))}" y2="${fmt(n(g.y2))}"${gt}>${stopXml}</linearGradient>`,
    )
  }
  return `url(#${id})`
}

// Images are emitted as placeholders and swapped for (downscaled) data URIs
// afterwards — embedding a 30 MB PNG as-is would make the SVG/PDF unusable.
const IMG_TOKEN = (key: string) => `__XDIMG_${key}__`

function imageHref(ctx: Ctx, pattern: Json, w: number, h: number): string | null {
  const key: string | undefined =
    pattern?.meta?.ux?.uid ?? (typeof pattern?.href === 'string' ? pattern.href.replace(/^\//, '') : undefined)
  if (!key || !/^[\w.-]+$/.test(key)) return null
  if (!ctx.files[`resources/${key}`]) return null
  const prev = ctx.imageNeeds.get(key)
  ctx.imageNeeds.set(key, { w: Math.max(prev?.w ?? 0, w), h: Math.max(prev?.h ?? 0, h) })
  return IMG_TOKEN(key)
}

/** fill / stroke / opacity / filter attributes for a node's style. */
function paintAttrs(ctx: Ctx, style: Json, isText = false): string {
  let out = ''
  const fill = style?.fill
  if (!fill || fill.type === 'none') {
    out += ' fill="none"'
  } else if (fill.type === 'solid' || (fill.color && !fill.type)) {
    const c = color(fill.color)
    if (c) {
      out += ` fill="${c.value}"`
      if (c.alpha < 1) out += ` fill-opacity="${fmt(c.alpha)}"`
    } else out += ' fill="none"'
  } else if (fill.type === 'gradient' && fill.gradient) {
    out += ` fill="${gradientDef(ctx, fill.gradient) ?? 'none'}"`
  } else if (fill.type === 'pattern') {
    out += ' fill="none"' // image is drawn separately, clipped to the shape
  } else if (!isText) {
    out += ' fill="none"'
  }

  const stroke = style?.stroke
  if (stroke && stroke.type !== 'none' && n(stroke.width) > 0) {
    let paint: string | null = null
    let alpha = 1
    if (stroke.type === 'gradient' && stroke.gradient) paint = gradientDef(ctx, stroke.gradient)
    else {
      const c = color(stroke.color)
      if (c) ({ value: paint, alpha } = c)
    }
    if (paint) {
      out += ` stroke="${paint}" stroke-width="${fmt(n(stroke.width))}"`
      if (alpha < 1) out += ` stroke-opacity="${fmt(alpha)}"`
      if (stroke.cap) out += ` stroke-linecap="${esc(stroke.cap)}"`
      if (stroke.join) out += ` stroke-linejoin="${esc(stroke.join)}"`
      if (stroke.miterLimit) out += ` stroke-miterlimit="${fmt(n(stroke.miterLimit))}"`
      if (Array.isArray(stroke.dash) && stroke.dash.length)
        out += ` stroke-dasharray="${stroke.dash.map((d: number) => fmt(n(d))).join(' ')}"`
    }
  }
  return out
}

function nodeAttrs(ctx: Ctx, node: Json): string {
  const style = node.style ?? {}
  let out = transformAttr(node.transform)
  if (style.opacity != null && n(style.opacity, 1) < 1) out += ` opacity="${fmt(n(style.opacity))}"`
  if (style.blendMode && style.blendMode !== 'pass-through' && style.blendMode !== 'normal')
    out += ` style="mix-blend-mode:${esc(style.blendMode)}"`

  const filters: Json[] = Array.isArray(style.filters) ? style.filters : []
  const prims: string[] = []
  for (const f of filters) {
    if (f.visible === false || f.params?.visible === false) continue
    if (f.type === 'dropShadow') {
      for (const s of f.params?.dropShadowList ?? []) {
        const c = color(s.color)
        if (!c) continue
        prims.push(
          `<feDropShadow dx="${fmt(n(s.dx))}" dy="${fmt(n(s.dy))}" stdDeviation="${fmt(n(s.r) / 2)}" flood-color="${c.value}" flood-opacity="${fmt(c.alpha)}"/>`,
        )
      }
    } else if (f.type === 'uxdesign#blur' || f.type === 'blur') {
      const r = n(f.params?.blurAmount ?? f.params?.r)
      if (r > 0 && !f.params?.backgroundEffect) prims.push(`<feGaussianBlur stdDeviation="${fmt(r / 2)}"/>`)
    }
  }
  if (prims.length) {
    const id = uid(ctx, 'f')
    ctx.defs.push(
      `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${prims.join('')}</filter>`,
    )
    out += ` filter="url(#${id})"`
  }
  return out
}

/* ------------------------------------------------------------------ shapes */

function rectPath(x: number, y: number, w: number, h: number, r: number[]): string {
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2))
  return (
    `M${fmt(x + tl)} ${fmt(y)}H${fmt(x + w - tr)}` +
    (tr ? `A${fmt(tr)} ${fmt(tr)} 0 0 1 ${fmt(x + w)} ${fmt(y + tr)}` : '') +
    `V${fmt(y + h - br)}` +
    (br ? `A${fmt(br)} ${fmt(br)} 0 0 1 ${fmt(x + w - br)} ${fmt(y + h)}` : '') +
    `H${fmt(x + bl)}` +
    (bl ? `A${fmt(bl)} ${fmt(bl)} 0 0 1 ${fmt(x)} ${fmt(y + h - bl)}` : '') +
    `V${fmt(y + tl)}` +
    (tl ? `A${fmt(tl)} ${fmt(tl)} 0 0 1 ${fmt(x + tl)} ${fmt(y)}` : '') +
    'Z'
  )
}

/** Geometry element (no paint) + its bounding box, or null if unknown. */
function geometry(shape: Json): { el: string; box: [number, number, number, number] } | null {
  switch (shape?.type) {
    case 'rect': {
      const x = n(shape.x), y = n(shape.y), w = n(shape.width), h = n(shape.height)
      const r: number[] = Array.isArray(shape.r) ? shape.r.map((v: unknown) => n(v)) : [n(shape.r), n(shape.r), n(shape.r), n(shape.r)]
      const box: [number, number, number, number] = [x, y, w, h]
      if (r.every((v) => v === r[0])) {
        const rr = r[0] ? ` rx="${fmt(Math.min(r[0], w / 2, h / 2))}"` : ''
        return { el: `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"${rr}`, box }
      }
      return { el: `<path d="${rectPath(x, y, w, h, r)}"`, box }
    }
    case 'ellipse': {
      const cx = n(shape.cx), cy = n(shape.cy), rx = n(shape.rx), ry = n(shape.ry)
      return { el: `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}"`, box: [cx - rx, cy - ry, rx * 2, ry * 2] }
    }
    case 'circle': {
      const cx = n(shape.cx), cy = n(shape.cy), r = n(shape.r)
      return { el: `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"`, box: [cx - r, cy - r, r * 2, r * 2] }
    }
    case 'line': {
      const x1 = n(shape.x1), y1 = n(shape.y1), x2 = n(shape.x2), y2 = n(shape.y2)
      return {
        el: `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"`,
        box: [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)],
      }
    }
    case 'polygon':
    case 'polyline': {
      // Polygons usually also carry a precomputed path; prefer that.
      if (Array.isArray(shape.points) && !shape.path) {
        const pts: Array<{ x: number; y: number }> = shape.points
        const xs = pts.map((p) => n(p.x)), ys = pts.map((p) => n(p.y))
        const minX = Math.min(...xs), minY = Math.min(...ys)
        return {
          el: `<${shape.type} points="${pts.map((p) => `${fmt(n(p.x))},${fmt(n(p.y))}`).join(' ')}"`,
          box: [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY],
        }
      }
      return pathGeometry(shape)
    }
    default: // path, compound (boolean ops are pre-flattened into .path), unknown
      return pathGeometry(shape)
  }
}

function pathGeometry(shape: Json): { el: string; box: [number, number, number, number] } | null {
  if (typeof shape?.path !== 'string' || !shape.path) return null
  const rule = shape.fillRule === 'evenodd' || shape.winding === 'evenodd' ? ' fill-rule="evenodd"' : ''
  return { el: `<path d="${esc(shape.path)}"${rule}`, box: pathBox(shape) }
}

/** Approximate bbox of an XD path (XD writes absolute M/L/C/Z commands). */
function pathBox(shape: Json): [number, number, number, number] {
  if (n(shape.width) && n(shape.height)) return [0, 0, n(shape.width), n(shape.height)]
  const nums = (shape.path as string).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
  if (nums.length < 2) return [0, 0, 0, 0]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i])
    minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1])
  }
  return [minX, minY, maxX - minX, maxY - minY]
}

function renderShape(ctx: Ctx, node: Json): string {
  const geo = geometry(node.shape)
  if (!geo) {
    ctx.skipped++
    return ''
  }
  const style = node.style ?? {}
  const attrs = nodeAttrs(ctx, node)
  const shapeEl = `${geo.el}${paintAttrs(ctx, style)}/>`
  if (style.fill?.type !== 'pattern') return `<g${attrs}>${shapeEl}</g>`

  // Image fill: clip the image to the shape, then draw the stroke on top.
  const [x, y] = geo.box
  let [, , w, h] = geo.box
  if (!w || !h) {
    w = n(style.fill.pattern.width)
    h = n(style.fill.pattern.height)
  }
  const href = imageHref(ctx, style.fill.pattern, w, h)
  if (!href) return `<g${attrs}>${shapeEl}</g>`
  const clipId = uid(ctx, 'c')
  ctx.defs.push(`<clipPath id="${clipId}">${geo.el}/></clipPath>`)
  const fit = style.fill.pattern.meta?.ux?.scaleBehavior === 'fill' ? 'none' : 'xMidYMid slice'
  return (
    `<g${attrs}><g clip-path="url(#${clipId})"><image x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="${fit}" xlink:href="${href}"/></g>` +
    shapeEl.replace(/ fill="[^"]*"/, ' fill="none"') +
    '</g>'
  )
}

/* -------------------------------------------------------------------- text */

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold|sm ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
]

interface FontSpec {
  family?: string
  style?: string
  postscriptName?: string
  size?: number
}

function fontAttrs(font: FontSpec | null | undefined): string {
  if (!font) return ''
  let out = ''
  // Most specific name first. XD families often hold many widths of one weight
  // ("Sharp Grotesk Bold" 05–25), so the bare family can resolve to the wrong
  // width; the PostScript name ("SharpGroteskBold19") picks the exact face.
  const names: string[] = []
  if (font.postscriptName) names.push(font.postscriptName)
  if (font.family && / /.test(font.family) && font.style && /^\d+$/.test(font.style)) names.push(`${font.family} ${font.style}`)
  if (font.family) names.push(font.family)
  const unique = [...new Set(names)]
  if (unique.length) out += ` font-family="${esc(`${unique.map((f) => `'${f.replace(/'/g, '')}'`).join(', ')}, sans-serif`)}"`
  if (font.size) out += ` font-size="${fmt(n(font.size))}"`
  // XD often encodes weight in the family ("Sharp Grotesk Bold") with a numeric style ("19").
  const st = `${font.family ?? ''} ${font.style ?? ''} ${font.postscriptName ?? ''}`
  const w = WEIGHTS.find(([re]) => re.test(st))
  if (w) out += ` font-weight="${w[1]}"`
  if (/italic|oblique/i.test(st)) out += ' font-style="italic"'
  return out
}

function fillAttr(c: { value: string; alpha: number } | null): string {
  return c ? ` fill="${c.value}"${c.alpha < 1 ? ` fill-opacity="${fmt(c.alpha)}"` : ''}` : ''
}

function applyCase(s: string, mode: unknown): string {
  switch (mode) {
    case 'uppercase':
      return s.toUpperCase()
    case 'lowercase':
      return s.toLowerCase()
    case 'titlecase':
      return s.replace(/(^|\s)(\S)/g, (_, a: string, b: string) => a + b.toUpperCase())
    default:
      return s
  }
}

/**
 * x of the alignment anchor for centered / right-aligned text, or null to
 * place each line at XD's measured left edge. Anchoring keeps the text where
 * it belongs even when the font renders a little wider or narrower than in XD.
 *
 * Where XD puts the origin, by text frame type:
 *   positioned (point text)  origin on the anchor, line x relative to it
 *   area (fixed box)         origin at the box's left, line x from that edge
 *   autoHeight               origin at the box's left, but centered lines'
 *                            x is measured from the box's centre
 */
function textAnchorX(t: Json, align: unknown, xs: number[]): number | null {
  const type = t?.frame?.type
  const w = n(t?.frame?.width)
  const all = (ok: (x: number) => boolean) => xs.every(ok)
  if (align === 'center') {
    if (type === 'area') return w && all((x) => x >= -1 && x <= w / 2 + 1) ? w / 2 : null
    if (type === 'autoHeight') return w && all((x) => x <= 1 && x >= -w / 2 - 1) ? w / 2 : null
    return all((x) => x <= 1) ? 0 : null
  }
  if (align === 'right') {
    if (type === 'area') return w && all((x) => x >= -1 && x <= w + 1) ? w : null
    if (type === 'autoHeight') return null // no samples seen; keep XD's measured positions
    return all((x) => x <= 1) ? 0 : null
  }
  return null
}

function renderText(ctx: Ctx, node: Json): string {
  const t = node.text
  const raw: string = t?.rawText ?? ''
  const style = node.style ?? {}
  const attrs = nodeAttrs(ctx, node)
  const base = fontAttrs(style.font) + paintAttrs(ctx, style, true)
  const fontSize = n(style.font?.size, 16)
  const ls = n(style.textAttributes?.letterSpacing)
  const spacing = ls ? ` letter-spacing="${fmt((ls / 1000) * fontSize)}"` : ''

  // Ranged styles: [{length, fontFamily, fontSize, fill, textTransform…}] covering rawText.
  const ranges: Array<{ from: number; to: number; s: Json }> = []
  let pos = 0
  for (const r of node.meta?.ux?.rangedStyles ?? []) {
    const len = n(r.length)
    ranges.push({ from: pos, to: pos + len, s: r })
    pos += len
  }
  // Ranged styles may stop short of the end of the text; the last style carries on.
  if (ranges.length && pos < raw.length) ranges[ranges.length - 1].to = pos = raw.length
  // Text as displayed (XD's "uppercase" etc. is a style, rawText keeps the
  // typed case). Transformed per range so title case sees whole words.
  let shown = raw
  if (ranges.some((r) => r.s.textTransform && r.s.textTransform !== 'none')) {
    const cased = ranges.map((r) => applyCase(raw.slice(r.from, r.to), r.s.textTransform)).join('') + raw.slice(pos)
    if (cased.length === raw.length) shown = cased // some case maps change length (ß → SS)
  }
  const caseAt = (i: number) => ranges.find((r) => i >= r.from && i < r.to)?.s.textTransform
  const slice = (from: number, to: number) =>
    shown !== raw || !ranges.length ? shown.slice(from, to) : applyCase(raw.slice(from, to), caseAt(from))

  const rangeAttrs = (s: Json) => {
    let a = fontAttrs({ family: s.fontFamily, size: s.fontSize, style: s.fontStyle, postscriptName: s.postscriptName })
    a += fillAttr(color(s.fill))
    const cs = n(s.charSpacing)
    if (cs !== ls) a += ` letter-spacing="${fmt((cs / 1000) * n(s.fontSize, fontSize))}"`
    const deco = [s.underline && 'underline', s.strikethrough && 'line-through'].filter(Boolean).join(' ')
    if (deco) a += ` text-decoration="${deco}"`
    return a
  }

  const segment = (from: number, to: number) => {
    if (ranges.length <= 1) return esc(slice(from, to))
    return ranges
      .filter((r) => r.to > from && r.from < to)
      .map((r) => `<tspan${rangeAttrs(r.s)}>${esc(slice(Math.max(from, r.from), Math.min(to, r.to)))}</tspan>`)
      .join('')
  }

  // Segments can override the node style (e.g. a bold first line).
  const segAttrs = (seg: Json) => {
    if (!seg.style) return ''
    return fontAttrs(seg.style.font) + fillAttr(color(seg.style.fill?.color))
  }

  let body = ''
  let anchor = ''
  const paragraphs: Json[] = t?.paragraphs ?? []
  if (paragraphs.length) {
    const lines: Json[][] = paragraphs.flatMap((p) => (p.lines ?? []) as Json[][]).map((l) => (l ?? []) as Json[])
    const align = style.textAttributes?.paragraphAlign
    const ax = textAnchorX(t, align, lines.flatMap((l) => l.map((seg) => n(seg.x))))
    if (ax != null) anchor = ` text-anchor="${align === 'center' ? 'middle' : 'end'}"`
    for (const line of lines) {
      const segs = line
        .map((seg) => ({ seg, from: n(seg.from), to: n(seg.to, raw.length) }))
        .filter((s) => s.to > s.from)
      if (!segs.length) continue
      if (ax == null) {
        for (const { seg, from, to } of segs)
          body += `<tspan x="${fmt(n(seg.x))}" y="${fmt(n(seg.y))}"${segAttrs(seg)}>${segment(from, to)}</tspan>`
        continue
      }
      // Anchored line: trailing spaces would shift it off-center.
      const last = segs[segs.length - 1]
      while (last.to > last.from && /\s/.test(raw[last.to - 1])) last.to--
      const inner = segs
        .filter((s) => s.to > s.from)
        .map(({ seg, from, to }) => {
          const a = segAttrs(seg)
          return a ? `<tspan${a}>${segment(from, to)}</tspan>` : segment(from, to)
        })
        .join('')
      body += `<tspan x="${fmt(ax)}" y="${fmt(n(segs[0].seg.y))}">${inner}</tspan>`
    }
  } else if (raw) {
    // No layout info: fall back to one line per hard break.
    const lh = n(style.textAttributes?.lineHeight, fontSize * 1.2)
    body = shown
      .split(/\r\n?|\n/)
      .map((l, i) => `<tspan x="0" y="${fmt(i * lh)}">${esc(l)}</tspan>`)
      .join('')
  }
  if (!body) return ''
  return `<g${attrs}><text xml:space="preserve"${base}${spacing}${anchor}>${body}</text></g>`
}

/* ----------------------------------------------------------------- traverse */

function clipFor(ctx: Ctx, node: Json): string {
  const ref = node.style?.clipPath?.ref
  const res = (ref && ctx.clipPaths[ref]) || node.meta?.ux?.clipPathResources
  const children: Json[] = res?.children ?? []
  if (!children.length) return ''
  // <g> isn't allowed inside <clipPath>, so put each transform on the shape itself.
  const inner = children
    .map((c) => {
      const geo = c.shape ? geometry(c.shape) : null
      return geo ? `${geo.el}${transformAttr(c.transform)}/>` : ''
    })
    .join('')
  if (!inner) return ''
  const id = uid(ctx, 'm')
  ctx.defs.push(`<clipPath id="${id}">${inner}</clipPath>`)
  return ` clip-path="url(#${id})"`
}

function layerKind(node: Json): XdLayer['kind'] {
  if (node.type === 'syncRef') return 'component'
  if (node.type === 'text') return 'text'
  if (node.type === 'shape' || (!node.group && node.shape))
    return node.style?.fill?.type === 'pattern' ? 'image' : 'shape'
  if (node.style?.clipPath?.ref || node.meta?.ux?.clipPathResources) return 'mask'
  return 'group'
}

function layerName(node: Json, kind: XdLayer['kind']): string {
  if (kind === 'text') {
    const t = String(node.text?.rawText ?? node.name ?? '').replace(/\s+/g, ' ').trim()
    if (t) return t.length > 48 ? `${t.slice(0, 47)}…` : t
  }
  if (typeof node.name === 'string' && node.name.trim()) return node.name.trim()
  return kind[0].toUpperCase() + kind.slice(1)
}

function renderNode(ctx: Ctx, node: Json, as?: Json): string {
  if (!node || node.visible === false) return ''
  if (ctx.depth > 64) {
    ctx.skipped++
    return ''
  }
  // A childless syncRef is a linked copy of a node inside a component master.
  if (node.type === 'syncRef' && !Array.isArray(node.group?.children)) {
    const src = ctx.symbols.get(node.syncSourceGuid)
    if (!src) {
      ctx.skipped++
      return ''
    }
    ctx.depth++
    // The instance's own layer entry describes the master's node.
    const out = renderNode(ctx, node.transform ? { ...src, transform: node.transform } : src, as ?? node)
    ctx.depth--
    return out
  }

  const kind = as ? 'component' : layerKind(node)
  const layer: XdLayer = {
    key: `xl${++ctx.layerIds}`,
    name: layerName(as?.name ? as : node, kind === 'component' ? layerKind(node) : kind),
    kind,
    children: [],
  }
  const parent = ctx.layerList
  ctx.layerList = layer.children
  ctx.depth++
  let out: string
  try {
    out = renderNodeInner(ctx, node)
  } finally {
    ctx.depth--
    ctx.layerList = parent
  }
  if (!out.startsWith('<g')) return out
  parent.push(layer)
  return `<g id="${layer.key}"${out.slice(2)}`
}

function renderNodeInner(ctx: Ctx, node: Json): string {
  switch (node.type) {
    case 'shape':
      return renderShape(ctx, node)
    case 'text':
      return renderText(ctx, node)
    default: {
      // group, syncRef (component instance), repeat grid, boolean group…
      const kids: Json[] | undefined = node.group?.children ?? node.children
      if (Array.isArray(kids)) {
        const clip = clipFor(ctx, node)
        return `<g${nodeAttrs(ctx, node)}${clip}>${kids.map((k) => renderNode(ctx, k)).join('')}</g>`
      }
      if (node.shape) return renderShape(ctx, node)
      ctx.skipped++
      return ''
    }
  }
}

/* ------------------------------------------------------------------ public */

interface ArtboardEntry {
  id: string
  path: string
  name: string
  bounds: Json
}

function listArtboards(files: Unzipped, manifest: Json): ArtboardEntry[] {
  const out: ArtboardEntry[] = []
  const walk = (node: Json) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.path === 'string' && node.path.startsWith('artboard-')) {
      out.push({
        id: node.path,
        path: `artwork/${node.path}/graphics/graphicContent.agc`,
        name: node.name ?? node.path,
        bounds: node['uxdesign#bounds'],
      })
    }
    for (const c of node.children ?? []) walk(c)
  }
  walk(manifest)
  // Fallback when the manifest shape is unfamiliar: scan the archive.
  if (out.length === 0) {
    for (const p of Object.keys(files)) {
      const m = /^artwork\/(artboard-[^/]+)\/graphics\/graphicContent\.agc$/.exec(p)
      if (m) out.push({ id: m[1], path: p, name: m[1], bounds: null })
    }
  }
  return out.filter((a) => files[a.path])
}

function indexSymbols(...roots: Json[]): Map<string, Json> {
  const map = new Map<string, Json>()
  const walk = (v: Json) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      if (typeof v.id === 'string' && typeof v.type === 'string') map.set(v.id, v)
      for (const k in v) if (k !== 'style' && k !== 'shape' && k !== 'text') walk(v[k])
    }
  }
  roots.forEach(walk)
  return map
}

interface RenderedArtboard extends Omit<XdArtboard, 'template'> {
  imageNeeds: Map<string, { w: number; h: number }>
}

function renderArtboard(
  files: Unzipped,
  entry: ArtboardEntry,
  shared: Json,
  symbols: Map<string, Json>,
): RenderedArtboard {
  const agc = readJson(files, entry.path)
  const ctx: Ctx = {
    files,
    gradients: { ...(shared?.resources?.gradients ?? {}), ...(agc?.resources?.gradients ?? {}) },
    clipPaths: { ...(shared?.resources?.clipPaths ?? {}), ...(agc?.resources?.clipPaths ?? {}) },
    defs: [],
    ids: 0,
    skipped: 0,
    symbols,
    imageNeeds: new Map(),
    depth: 0,
    layerIds: 0,
    layerList: [],
  }
  const roots: Json[] = agc?.children ?? []
  const abNode = roots.find((c) => c.type === 'artboard')
  const boards = shared?.artboards ?? {}
  const ref: string = abNode?.artboard?.ref ?? ''
  const info = boards[ref] ?? boards[`artboard-${ref}`] ?? boards[entry.id] ?? boards[entry.id.replace(/^artboard-/, '')] ?? {}
  const width = n(info.width, n(entry.bounds?.width, n(abNode?.artboard?.width, 1)))
  const height = n(info.height, n(entry.bounds?.height, n(abNode?.artboard?.height, 1)))
  const ox = n(info.x, n(entry.bounds?.x))
  const oy = n(info.y, n(entry.bounds?.y))

  const children: Json[] = abNode?.artboard?.children ?? (abNode ? [] : roots)
  const body = children.map((c) => renderNode(ctx, c)).join('')
  const layers = ctx.layerList

  let bg = ''
  const bgc = color(abNode?.style?.fill?.color)
  if (bgc && abNode?.style?.fill?.type !== 'none')
    bg = `<rect width="${fmt(width)}" height="${fmt(height)}" fill="${bgc.value}"${bgc.alpha < 1 ? ` fill-opacity="${fmt(bgc.alpha)}"` : ''}/>`

  // Children are stored in artboard-local coordinates in the files we've seen,
  // but older files use pasteboard coordinates. Detect the latter by measuring.
  const content = `<g id="content">${body}</g>`
  const vote = pasteboardVote(children, width, height, ox, oy)
  const shift = vote !== 0 ? vote > 0 : needsPasteboardShift(ctx.defs, content, width, height, ox, oy)
  const placed = shift ? `<g transform="translate(${fmt(-ox)} ${fmt(-oy)})">${content}</g>` : content

  const svg =
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">` +
    `<title>${esc(entry.name)}</title>` +
    (ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : '') +
    `<clipPath id="artboard-clip"><rect width="${fmt(width)}" height="${fmt(height)}"/></clipPath>` +
    `<g clip-path="url(#artboard-clip)">${bg}${placed}</g></svg>`

  return { id: entry.id, name: entry.name, width, height, svg, skipped: ctx.skipped, imageNeeds: ctx.imageNeeds, layers }
}

/**
 * Do the top-level layers sit in pasteboard coordinates? Each layer's origin
 * votes for the rectangle it falls in: the artboard at its pasteboard
 * position (+1) or at 0,0 (-1). 0 means undecided. Overall bounds alone can't
 * tell: one stray layer far off the artboard makes both positions overlap equally.
 */
function pasteboardVote(children: Json[], w: number, h: number, ox: number, oy: number): number {
  if (!ox && !oy) return -1
  const inside = (x: number, y: number, rx: number, ry: number) =>
    x >= rx - 1 && x <= rx + w + 1 && y >= ry - 1 && y <= ry + h + 1
  let score = 0
  for (const c of children) {
    const t = c?.transform
    if (!t || typeof t !== 'object') continue
    const x = n(t.tx), y = n(t.ty)
    score += (inside(x, y, ox, oy) ? 1 : 0) - (inside(x, y, 0, 0) ? 1 : 0)
  }
  return score
}

/** True if the content's bbox sits at the artboard's pasteboard position rather than at 0,0. */
function needsPasteboardShift(defs: string[], content: string, w: number, h: number, ox: number, oy: number): boolean {
  if (!ox && !oy) return false
  if (typeof document === 'undefined') return false
  // Parse as XML (inert: no script execution) and measure off-screen.
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}"><defs>${defs.join('')}</defs>${content}</svg>`,
    'image/svg+xml',
  )
  if (parsed.querySelector('parsererror')) return false
  const host = mountForMeasure(parsed.documentElement)
  try {
    const g = host.querySelector('#content') as SVGGraphicsElement | null
    const b = g?.getBBox()
    if (!b || (!b.width && !b.height)) return false
    const overlap = (x: number, y: number) =>
      Math.max(0, Math.min(b.x + b.width, x + w) - Math.max(b.x, x)) *
      Math.max(0, Math.min(b.y + b.height, y + h) - Math.max(b.y, y))
    return overlap(ox, oy) > overlap(0, 0)
  } catch {
    return false
  } finally {
    host.remove()
  }
}

/**
 * Mount a copy of an SVG off-screen so it can be measured. Image hrefs are
 * dropped from the copy: they are placeholders (or huge data URIs) and
 * <image> boxes come from x/y/width/height anyway.
 */
function mountForMeasure(svg: Element): HTMLDivElement {
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-99999px;top:0;overflow:hidden;visibility:hidden'
  const copy = document.importNode(svg, true)
  for (const img of copy.querySelectorAll('image')) {
    img.removeAttribute('href')
    img.removeAttributeNS('http://www.w3.org/1999/xlink', 'href')
  }
  host.appendChild(copy)
  document.body.appendChild(host)
  return host
}

export function isXdFile(file: File): boolean {
  return /\.xd$/i.test(file.name)
}

export interface ParseXdOptions {
  /**
   * Embedded images are downscaled to this multiple of their on-artboard size
   * (2 = retina-sharp). 0 keeps the original files untouched. XD files often
   * carry 20–30 MB source PNGs that would otherwise bloat the SVG and PDF.
   */
  imageScale?: number
  onProgress?: (message: string) => void
}

export async function parseXd(file: File, opts: ParseXdOptions = {}): Promise<XdDocument> {
  const { imageScale = 2, onProgress } = opts
  const data = new Uint8Array(await file.arrayBuffer())
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error(
      'This .xd file is not a local XD archive (it may be a cloud document). In Adobe XD use File → Save As… → "On your computer", then try again.',
    )
  }
  onProgress?.('Unpacking…')
  const files = await unzipAsync(data)
  const manifest = readJson(files, 'manifest')
  const shared = readJson(files, 'resources/graphics/graphicContent.agc')
  const symbols = indexSymbols(
    shared?.resources?.meta?.ux?.symbols,
    readJson(files, 'artwork/pasteboard/graphics/graphicContent.agc'),
  )

  onProgress?.('Converting artboards…')
  const rendered = listArtboards(files, manifest).map((e) => renderArtboard(files, e, shared, symbols))

  // Prepare each referenced image once, at the largest size any artboard needs.
  const needs = new Map<string, { w: number; h: number }>()
  for (const a of rendered)
    for (const [k, v] of a.imageNeeds) {
      const p = needs.get(k)
      needs.set(k, { w: Math.max(p?.w ?? 0, v.w), h: Math.max(p?.h ?? 0, v.h) })
    }
  const uris = await processImages(files, needs, imageScale, onProgress)

  const artboards: XdArtboard[] = rendered.map((a) => ({
    id: a.id,
    name: a.name,
    width: a.width,
    height: a.height,
    skipped: a.skipped,
    template: a.svg,
    svg: fillImages(a.svg, uris),
    layers: a.layers,
  }))

  const previewKey = Object.keys(files).find((k) => /(^|\/)(preview|thumbnail)\.(png|jpe?g)$/i.test(k))
  const previewUrl = previewKey
    ? URL.createObjectURL(new Blob([files[previewKey] as BlobPart], { type: sniffMime(files[previewKey]) ?? 'image/png' }))
    : null

  if (artboards.length === 0 && !previewUrl) {
    throw new Error('No artboards found in this XD file.')
  }
  return {
    name: file.name.replace(/\.xd$/i, ''),
    artboards,
    previewUrl,
    imageScale,
    imageUris: uris,
    source: { file, imageNeeds: needs },
  }
}

/** Re-process only the embedded images at a new scale; everything else is reused. */
export async function setXdImageScale(
  doc: XdDocument,
  imageScale: number,
  onProgress?: (message: string) => void,
): Promise<XdDocument> {
  const { file, imageNeeds } = doc.source
  let uris = new Map<string, string>()
  if (imageNeeds.size) {
    onProgress?.('Unpacking images…')
    const wanted = new Set([...imageNeeds.keys()].map((k) => `resources/${k}`))
    const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()), (name) => wanted.has(name))
    uris = await processImages(files, imageNeeds, imageScale, onProgress)
  }
  return {
    ...doc,
    imageScale,
    imageUris: uris,
    artboards: doc.artboards.map((a) => ({ ...a, svg: fillImages(a.template, uris) })),
  }
}

async function processImages(
  files: Unzipped,
  needs: Map<string, { w: number; h: number }>,
  scale: number,
  onProgress?: (message: string) => void,
): Promise<Map<string, string>> {
  const uris = new Map<string, string>()
  let done = 0
  for (const [key, size] of needs) {
    onProgress?.(`Processing images ${++done}/${needs.size}…`)
    const uri = await imageDataUri(files[`resources/${key}`], size, scale)
    if (uri) uris.set(key, uri)
  }
  return uris
}

// 1×1 transparent PNG: keeps <image> boxes clickable without the image data.
const BLANK_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function fillImages(template: string, uris: Map<string, string> | 'blank'): string {
  return template.replace(/__XDIMG_([\w.-]+)__/g, (_, k: string) => (uris === 'blank' ? BLANK_IMAGE : (uris.get(k) ?? '')))
}

/**
 * Data URI for an embedded image, downscaled so it still covers its largest
 * on-artboard box at `scale`× (never upscaled). Opaque images become JPEG,
 * images with transparency stay PNG — both formats jsPDF can embed.
 */
async function imageDataUri(
  bytes: Uint8Array | undefined,
  box: { w: number; h: number },
  scale: number,
): Promise<string | null> {
  if (!bytes) return null
  const mime = sniffMime(bytes)
  if (!mime || mime === 'image/svg+xml') return null
  const original = `data:${mime};base64,${toBase64(bytes)}`
  if (!scale || typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return original

  let bmp: ImageBitmap | null = null
  try {
    const blob = new Blob([bytes as BlobPart], { type: mime })
    bmp = await createImageBitmap(blob)
    const { width: iw, height: ih } = bmp
    // "cover" fit: the image is scaled so both box dimensions are filled.
    const s = Math.max(box.w / iw, box.h / ih) * scale
    const keepOriginal = !(s > 0) || s >= 0.9 // within 10%: not worth re-encoding
    if (keepOriginal && (mime === 'image/png' || mime === 'image/jpeg')) return original
    const w = Math.max(1, Math.round(iw * Math.min(1, s || 1)))
    const h = Math.max(1, Math.round(ih * Math.min(1, s || 1)))
    const canvas = new OffscreenCanvas(w, h)
    const g = canvas.getContext('2d')
    if (!g) return original
    g.imageSmoothingQuality = 'high'
    g.drawImage(bmp, 0, 0, w, h)
    const px = g.getImageData(0, 0, w, h).data
    let opaque = true
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 255) {
        opaque = false
        break
      }
    }
    const out = await canvas.convertToBlob(opaque ? { type: 'image/jpeg', quality: 0.88 } : { type: 'image/png' })
    const outBytes = new Uint8Array(await out.arrayBuffer())
    return outBytes.length < bytes.length ? `data:${out.type};base64,${toBase64(outBytes)}` : original
  } catch {
    return original
  } finally {
    bmp?.close()
  }
}

/** Display variant: drop fixed size so <img> scales from the viewBox. */
export function toDisplaySvg(svg: string): string {
  return svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, '<svg$1')
}

/* --------------------------------------------------------- layer extraction */

export interface ComposeOptions {
  /** Layer keys to leave out. */
  hidden?: ReadonlySet<string>
  /** Export only these layers, cropped to their bounds (artboard background dropped). */
  only?: ReadonlySet<string>
}

export interface ComposedSvg {
  svg: string
  width: number
  height: number
}

/**
 * Artboard SVG with hidden layers removed, or only the chosen layers, cropped
 * to their visible bounds. Browser only.
 */
export function composeArtboard(doc: XdDocument, board: XdArtboard, opts: ComposeOptions = {}): ComposedSvg {
  if (!opts.hidden?.size && !opts.only?.size) return { svg: board.svg, width: board.width, height: board.height }
  const t = composeTemplate(board, opts)
  return { ...t, svg: t.svg && fillImages(t.svg, doc.imageUris) }
}

/**
 * Like composeArtboard, but in two flavours from one pass: `svg` with the
 * images, and `hit` with every image replaced by a transparent pixel — same
 * geometry and layer ids, cheap enough to put in the DOM for hit testing.
 */
export function composeArtboardWithHit(
  doc: XdDocument,
  board: XdArtboard,
  opts: ComposeOptions = {},
): ComposedSvg & { hit: string } {
  const t = composeTemplate(board, opts)
  return { ...t, svg: t.svg && fillImages(t.svg, doc.imageUris), hit: t.svg && fillImages(t.svg, 'blank') }
}

/**
 * composeArtboard on the image-less template, so it stays fast even when the
 * artboard embeds tens of MB of images. `svg` still holds image placeholders.
 */
function composeTemplate(board: XdArtboard, opts: ComposeOptions): ComposedSvg {
  const { hidden, only } = opts
  const plain = { svg: board.template, width: board.width, height: board.height }
  if (!hidden?.size && !only?.size) return plain

  const parsed = new DOMParser().parseFromString(board.template, 'image/svg+xml')
  const root = parsed.documentElement
  if (parsed.querySelector('parsererror')) return plain
  const byKey = (k: string) => root.querySelector(`[id="${CSS.escape(k)}"]`)

  for (const k of hidden ?? []) byKey(k)?.remove()

  let width = board.width
  let height = board.height
  if (only?.size) {
    // Outermost selected elements only (a selected group already contains its children).
    const picked = [...only]
      .map(byKey)
      .filter((el): el is Element => !!el)
      .filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)))
    if (!picked.length) return { svg: '', width: 0, height: 0 }

    const keep = new Set(picked)
    const path = new Set<Element>()
    for (const el of picked) for (let p = el.parentElement; p; p = p.parentElement) path.add(p)
    const prune = (el: Element) => {
      for (const child of [...el.children]) {
        if (keep.has(child)) continue
        if (path.has(child)) prune(child)
        else if (!/^(defs|title|clipPath)$/.test(child.localName)) child.remove()
      }
    }
    prune(root)
    // Extracted items shouldn't be cut off at the artboard edge.
    root.querySelector('[clip-path="url(#artboard-clip)"]')?.removeAttribute('clip-path')

    const box = measureLayers(root, picked.map((el) => el.id))
    if (!box) return { svg: '', width: 0, height: 0 }
    const [x, y, w, h] = box
    width = w
    height = h
    root.setAttribute('viewBox', `${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}`)
    root.setAttribute('width', fmt(w))
    root.setAttribute('height', fmt(h))
  }

  return { svg: new XMLSerializer().serializeToString(root), width, height }
}

/** Union of the elements' visible boxes (clip paths applied, strokes padded), in artboard units. */
function measureLayers(svg: Element, ids: string[]): [number, number, number, number] | null {
  const host = mountForMeasure(svg)
  try {
    const live = host.firstElementChild as SVGSVGElement
    const origin = live.getBoundingClientRect()
    // The SVG renders at width/height == viewBox size, so 1 CSS px == 1 unit.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const id of ids) {
      const el = live.querySelector(`[id="${CSS.escape(id)}"]`)
      if (!el) continue
      const r = visibleRect(live, el)
      if (!r) continue
      let pad = 0
      for (const s of [el, ...el.querySelectorAll('[stroke-width]')]) {
        if (s.getAttribute('stroke') && s.getAttribute('stroke') !== 'none')
          pad = Math.max(pad, n(parseFloat(s.getAttribute('stroke-width') ?? '')) / 2)
      }
      x0 = Math.min(x0, r.left - pad)
      y0 = Math.min(y0, r.top - pad)
      x1 = Math.max(x1, r.right + pad)
      y1 = Math.max(y1, r.bottom + pad)
    }
    if (!(x1 > x0 && y1 > y0)) return null
    // Back to the SVG's own (viewBox) coordinates.
    const vb = live.viewBox.baseVal
    const sx = vb && vb.width ? vb.width / origin.width : 1
    const sy = vb && vb.height ? vb.height / origin.height : 1
    const ox = vb ? vb.x : 0
    const oy = vb ? vb.y : 0
    return [ox + (x0 - origin.left) * sx, oy + (y0 - origin.top) * sy, (x1 - x0) * sx, (y1 - y0) * sy]
  } finally {
    host.remove()
  }
}

export type Rect = { left: number; top: number; right: number; bottom: number }

/**
 * Screen box of a rendered element, cut down by the clip paths (masks) of it
 * and its ancestors, so a masked photo reports the visible window rather than
 * the whole image. `root` must be a live, laid-out <svg>.
 */
export function visibleRect(root: Element, el: Element): Rect | null {
  let r = rectOf(el)
  for (let p: Element | null = el; p && p !== root; p = p.parentElement) {
    const m = /url\(#([^)]+)\)/.exec(p.getAttribute('clip-path') ?? '')
    const clip = m && root.querySelector(`[id="${CSS.escape(m[1])}"]`)
    if (!clip) continue
    const probe = document.createElementNS(SVG_NS, 'g')
    for (const c of clip.children) probe.appendChild(c.cloneNode(true))
    p.appendChild(probe)
    r = intersect(r, rectOf(probe))
    probe.remove()
  }
  return r
}

function rectOf(el: Element): Rect | null {
  const r = el.getBoundingClientRect()
  return r.width || r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
}

function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return null
  if (!b) return a // unmeasurable clip: keep the element's own box
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  return r.right > r.left && r.bottom > r.top ? r : null
}

/** Depth-first visit of a layer tree. */
export function walkLayers(layers: XdLayer[], fn: (l: XdLayer) => void) {
  for (const l of layers) {
    fn(l)
    walkLayers(l.children, fn)
  }
}

/** Layer key → parent layer key (null at the top level). */
export function layerParents(layers: XdLayer[]): Map<string, string | null> {
  const map = new Map<string, string | null>()
  const walk = (list: XdLayer[], parent: string | null) => {
    for (const l of list) {
      map.set(l.key, parent)
      walk(l.children, l.key)
    }
  }
  walk(layers, null)
  return map
}

function isAncestor(parents: Map<string, string | null>, a: string, b: string): boolean {
  for (let p = parents.get(b); p; p = parents.get(p)) if (p === a) return true
  return false
}

/**
 * Which layer a click on the canvas selects, given the layers under the
 * pointer (outermost first). Like Figma: a click picks the top-level layer,
 * or a sibling of the current selection once you have gone into a group;
 * `drill` (double-click) goes one level deeper; `deep` (⌘-click) picks the
 * innermost layer.
 */
export function pickLayer(
  chain: string[],
  selected: ReadonlySet<string>,
  parents: Map<string, string | null>,
  how: { deep?: boolean; drill?: boolean } = {},
): string | null {
  if (!chain.length) return null
  if (how.deep) return chain[chain.length - 1]
  let depth = 0
  for (const s of selected) {
    const i = chain.indexOf(s)
    if (i >= 0) {
      depth = Math.max(depth, how.drill ? i + 1 : i)
      continue
    }
    const p = parents.get(s)
    const j = p ? chain.indexOf(p) : -1
    if (j >= 0) depth = Math.max(depth, j + 1)
  }
  return chain[Math.min(depth, chain.length - 1)]
}

/** Shift-click: toggle a layer, dropping any of its ancestors or descendants. */
export function toggleLayer(
  selected: ReadonlySet<string>,
  key: string,
  parents: Map<string, string | null>,
): Set<string> {
  if (selected.has(key)) return new Set([...selected].filter((s) => s !== key))
  const next = new Set([...selected].filter((s) => !isAncestor(parents, s, key) && !isAncestor(parents, key, s)))
  next.add(key)
  return next
}
