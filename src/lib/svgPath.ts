// Minimal SVG path + transform geometry, shared by layer grouping (bounding
// boxes) and Lottie export (bezier vertices).
//
// Every segment is normalised to an absolute cubic bezier. Straight lines get
// control points equal to their endpoints, so their Lottie tangents are zero.
// Arcs never appear in tracer output; if one does, it degrades to a line.

export type Point = [number, number]
/** Affine matrix [a, b, c, d, e, f] as in SVG `matrix(...)`. */
export type Matrix = [number, number, number, number, number, number]

export interface Cubic {
  c1: Point
  c2: Point
  p: Point
}

export interface Subpath {
  start: Point
  segments: Cubic[]
  closed: boolean
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

// Commands and their argument counts.
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

export function parsePath(d: string): Subpath[] {
  const tokens = d.match(/[a-df-zA-DF-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []
  const subpaths: Subpath[] = []
  let current: Subpath | null = null
  let pos: Point = [0, 0]
  let lastCtrl: Point | null = null // reflection point for S/T
  let lastCmd = ''
  let i = 0

  const lineTo = (p: Point) => {
    current!.segments.push({ c1: pos, c2: p, p })
    pos = p
  }

  while (i < tokens.length) {
    let cmd = tokens[i]
    if (/[a-zA-Z]/.test(cmd)) i++
    else if (lastCmd) cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd // implicit repeat
    else break

    const lower = cmd.toLowerCase()
    const rel = cmd !== cmd.toUpperCase()
    const n = ARITY[lower]
    if (n === undefined) break
    const args = tokens.slice(i, i + n).map(Number)
    if (args.length < n || args.some(Number.isNaN)) break
    i += n
    const pt = (x: number, y: number): Point => (rel ? [pos[0] + x, pos[1] + y] : [x, y])

    if (lower === 'z') {
      if (current) {
        current.closed = true
        pos = current.start
        current = null
      }
      lastCtrl = null
      lastCmd = cmd
      continue
    }

    if (lower === 'm') {
      pos = pt(args[0], args[1])
      current = { start: pos, segments: [], closed: false }
      subpaths.push(current)
      lastCtrl = null
      lastCmd = cmd
      continue
    }

    if (!current) {
      // drawing command without a preceding moveto: start at current point
      current = { start: pos, segments: [], closed: false }
      subpaths.push(current)
    }

    switch (lower) {
      case 'l':
        lineTo(pt(args[0], args[1]))
        lastCtrl = null
        break
      case 'h':
        lineTo([rel ? pos[0] + args[0] : args[0], pos[1]])
        lastCtrl = null
        break
      case 'v':
        lineTo([pos[0], rel ? pos[1] + args[0] : args[0]])
        lastCtrl = null
        break
      case 'c': {
        const c1 = pt(args[0], args[1])
        const c2 = pt(args[2], args[3])
        const p = pt(args[4], args[5])
        current.segments.push({ c1, c2, p })
        lastCtrl = c2
        pos = p
        break
      }
      case 's': {
        const c1: Point =
          lastCtrl && /[cs]/i.test(lastCmd) ? [2 * pos[0] - lastCtrl[0], 2 * pos[1] - lastCtrl[1]] : pos
        const c2 = pt(args[0], args[1])
        const p = pt(args[2], args[3])
        current.segments.push({ c1, c2, p })
        lastCtrl = c2
        pos = p
        break
      }
      case 'q':
      case 't': {
        const q: Point =
          lower === 'q'
            ? pt(args[0], args[1])
            : lastCtrl && /[qt]/i.test(lastCmd)
              ? [2 * pos[0] - lastCtrl[0], 2 * pos[1] - lastCtrl[1]]
              : pos
        const p = lower === 'q' ? pt(args[2], args[3]) : pt(args[0], args[1])
        // quadratic → cubic: control points 2/3 of the way to q
        const c1: Point = [pos[0] + (2 / 3) * (q[0] - pos[0]), pos[1] + (2 / 3) * (q[1] - pos[1])]
        const c2: Point = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])]
        current.segments.push({ c1, c2, p })
        lastCtrl = q
        pos = p
        break
      }
      case 'a':
        lineTo(pt(args[5], args[6]))
        lastCtrl = null
        break
    }
    lastCmd = cmd
  }
  return subpaths
}

export function parseTransform(attr: string | null): Matrix {
  let m: Matrix = IDENTITY
  if (!attr) return m
  for (const [, fn, rawArgs] of attr.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = rawArgs.split(/[\s,]+/).filter(Boolean).map(Number)
    let t: Matrix
    switch (fn) {
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
        break
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
        break
      case 'matrix':
        t = [a[0], a[1], a[2], a[3], a[4], a[5]]
        break
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0]
        const cos = Math.cos(r)
        const sin = Math.sin(r)
        t = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
        break
      }
      default:
        continue // skewX/skewY never appear in tracer output
    }
    m = multiply(m, t)
  }
  return m
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export function apply(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function transformSubpaths(subpaths: Subpath[], m: Matrix): Subpath[] {
  if (m === IDENTITY) return subpaths
  return subpaths.map((s) => ({
    start: apply(m, s.start),
    closed: s.closed,
    segments: s.segments.map((seg) => ({ c1: apply(m, seg.c1), c2: apply(m, seg.c2), p: apply(m, seg.p) })),
  }))
}

/**
 * Bounding box of all points incl. control points. A bezier lies inside its
 * control hull, so this is a (slightly loose) superset of the true bounds —
 * which is what the overlap tests need: disjoint boxes ⇒ disjoint shapes.
 */
export function bbox(subpaths: Subpath[]): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = ([x, y]: Point) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const s of subpaths) {
    add(s.start)
    for (const seg of s.segments) {
      add(seg.c1)
      add(seg.c2)
      add(seg.p)
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

export function overlaps(a: BBox, b: BBox, pad = 0): boolean {
  return (
    a.minX - pad < b.maxX && b.minX - pad < a.maxX && a.minY - pad < b.maxY && b.minY - pad < a.maxY
  )
}

export function union(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}
