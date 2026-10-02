// SVG → Lottie JSON for a still image.
//
// Each top-level <g> becomes a shape layer named after its id; nested groups
// become Lottie shape groups; each <path> becomes a group holding one bezier
// shape per subpath plus a fill. Transforms are baked into the coordinates.
// Lottie draws the first layer / first shape item on top, the reverse of SVG
// document order, so every child list is reversed.

import { IDENTITY, multiply, parsePath, parseTransform, transformSubpaths, type Matrix, type Point, type Subpath } from './svgPath'
import { parseColor } from './layers'

const FRAME_RATE = 30
const DURATION_FRAMES = 60 // a still frame, but players expect a non-zero length

type LottieShape = Record<string, unknown>

const round = (n: number) => Math.round(n * 1000) / 1000
const sub = (a: Point, b: Point): number[] => [round(a[0] - b[0]), round(a[1] - b[1])]
const pt = (p: Point): number[] => [round(p[0]), round(p[1])]
const still = (k: unknown) => ({ a: 0, k })

// A fresh object per group: players such as lottie-web mutate the data they
// load, so shared references between shapes break rendering.
const identityTransform = () => ({
  ty: 'tr',
  p: still([0, 0]),
  a: still([0, 0]),
  s: still([100, 100]),
  r: still(0),
  o: still(100),
  sk: still(0),
  sa: still(0),
})

function bezierShape(s: Subpath): LottieShape | null {
  if (s.segments.length === 0) return null
  const v: Point[] = [s.start]
  const i: number[][] = [[0, 0]]
  const o: number[][] = []
  for (const seg of s.segments) {
    o.push(sub(seg.c1, v[v.length - 1]))
    v.push(seg.p)
    i.push(sub(seg.c2, seg.p))
  }
  o.push([0, 0])

  // A closed path usually ends back on its start point; merge that duplicate so
  // the closing curve keeps its in-tangent.
  const last = v[v.length - 1]
  if (s.closed && v.length > 1 && Math.abs(last[0] - s.start[0]) < 1e-6 && Math.abs(last[1] - s.start[1]) < 1e-6) {
    v.pop()
    i[0] = i.pop()!
    o.pop()
  }
  return { ty: 'sh', ks: still({ c: s.closed, v: v.map(pt), i, o }) }
}

function opacity(el: Element, attr: 'fill-opacity' | 'stroke-opacity'): number {
  const f = parseFloat(el.getAttribute(attr) ?? '1')
  const o = parseFloat(el.getAttribute('opacity') ?? '1')
  return Math.round((Number.isNaN(f) ? 1 : f) * (Number.isNaN(o) ? 1 : o) * 100)
}

const lottieColor = (rgb: [number, number, number]) => still([...rgb.map((c) => round(c / 255)), 1])

function convertPath(el: Element, m: Matrix): LottieShape | null {
  if (el.getAttribute('display') === 'none') return null
  const fill = el.getAttribute('fill') ?? '#000000' // SVG default fill is black
  const fillRgb = fill === 'none' ? null : parseColor(fill)
  // imagetracerjs strokes every path in its own color to close the seams
  const stroke = el.getAttribute('stroke')
  const strokeRgb = stroke && stroke !== 'none' ? parseColor(stroke) : null
  const strokeWidth = parseFloat(el.getAttribute('stroke-width') ?? '1')
  if (!fillRgb && !(strokeRgb && strokeWidth > 0)) return null

  const matrix = multiply(m, parseTransform(el.getAttribute('transform')))
  const shapes = transformSubpaths(parsePath(el.getAttribute('d') ?? ''), matrix)
    .map(bezierShape)
    .filter((s): s is LottieShape => !!s)
  if (!shapes.length) return null

  const styles: LottieShape[] = []
  // stroke before fill: Lottie paints earlier items on top, SVG strokes over fills
  if (strokeRgb && strokeWidth > 0) {
    styles.push({
      ty: 'st',
      c: lottieColor(strokeRgb),
      o: still(opacity(el, 'stroke-opacity')),
      w: still(round(strokeWidth * Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])))),
      lc: 1, // butt, the SVG default
      lj: 1, // miter
      ml: 4,
    })
  }
  if (fillRgb) {
    styles.push({
      ty: 'fl',
      c: lottieColor(fillRgb),
      o: still(opacity(el, 'fill-opacity')),
      r: el.getAttribute('fill-rule') === 'evenodd' ? 2 : 1,
    })
  }
  return { ty: 'gr', nm: el.getAttribute('id') ?? 'path', it: [...shapes, ...styles, identityTransform()] }
}

function convertChildren(parent: Element, m: Matrix): LottieShape[] {
  const out: LottieShape[] = []
  for (const child of Array.from(parent.children).reverse()) {
    const shape = convertNode(child, m)
    if (shape) out.push(shape)
  }
  return out
}

function convertNode(el: Element, m: Matrix): LottieShape | null {
  if (el.localName === 'path') return convertPath(el, m)
  if (el.localName !== 'g' || el.getAttribute('display') === 'none') return null
  const items = convertChildren(el, multiply(m, parseTransform(el.getAttribute('transform'))))
  if (!items.length) return null
  return { ty: 'gr', nm: el.getAttribute('id') ?? 'group', it: [...items, identityTransform()] }
}

function shapeLayer(name: string, shapes: LottieShape[], ind: number) {
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm: name,
    sr: 1,
    ks: { o: still(100), r: still(0), p: still([0, 0, 0]), a: still([0, 0, 0]), s: still([100, 100, 100]) },
    ao: 0,
    shapes,
    ip: 0,
    op: DURATION_FRAMES,
    st: 0,
    bm: 0,
  }
}

/** Convert an SVG string (as produced by the export pipeline) to a Lottie object. */
export function svgToLottie(svg: string, name: string): object {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const svgEl = doc.querySelector('svg')
  if (!svgEl) throw new Error('Not an SVG')

  const vb = (svgEl.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const [minX, minY, w, h] =
    vb.length === 4 && vb.every((n) => !Number.isNaN(n))
      ? vb
      : [0, 0, parseFloat(svgEl.getAttribute('width') ?? '0'), parseFloat(svgEl.getAttribute('height') ?? '0')]
  const root: Matrix = minX || minY ? [1, 0, 0, 1, -minX, -minY] : IDENTITY

  // Top-level groups become layers; runs of loose top-level paths share one.
  const layers: Array<{ name: string; shapes: LottieShape[] }> = []
  let loose: LottieShape[] = []
  const flush = () => {
    if (loose.length) layers.push({ name: `shapes-${layers.length + 1}`, shapes: loose.reverse() })
    loose = []
  }
  for (const child of Array.from(svgEl.children)) {
    if (child.localName === 'g') {
      flush()
      const shape = convertNode(child, root)
      if (shape) layers.push({ name: shape.nm as string, shapes: [shape] })
    } else {
      const shape = convertNode(child, root)
      if (shape) loose.push(shape)
    }
  }
  flush()

  return {
    v: '5.12.2',
    fr: FRAME_RATE,
    ip: 0,
    op: DURATION_FRAMES,
    w: Math.round(w),
    h: Math.round(h),
    nm: name,
    ddd: 0,
    assets: [],
    layers: layers.reverse().map((l, k) => shapeLayer(l.name, l.shapes, k + 1)),
    markers: [],
  }
}
