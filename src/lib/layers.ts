// Layer structure for export: turn the tracer's flat <path> list into named
// <g> groups that show up as layers in Figma / Illustrator / Lottie.
//
// The catch is paint order. In VTracer's "stacked" mode later paths paint over
// earlier ones, so moving a path into an earlier group can change the picture
// (e.g. a white letter counter would end up under the black letter). A path is
// only ever moved past paths whose bounding boxes it does not touch, which is
// always safe: shapes that don't overlap can be drawn in any order.

import { bbox, overlaps, parsePath, parseTransform, transformSubpaths, union, type BBox } from './svgPath'
import { ensureViewBox, normalizeColor } from './vectorView'

const SVG_NS = 'http://www.w3.org/2000/svg'
// Boxes closer than this (canvas px) count as overlapping: shapes that merely
// touch still share anti-aliased seam pixels, whose blend depends on order.
const TOUCH = 1
const parser = new DOMParser()
const serializer = new XMLSerializer()

export interface TracedPath {
  index: number // position in the original document order
  el: SVGPathElement
  color: string // normalized layer key (same as ColorLayer.color)
  box: BBox | null // canvas coordinates; null if the path couldn't be measured
}

/** A run of paths that becomes one <g>. */
export interface PathGroup {
  color: string
  paths: TracedPath[]
  box: BBox | null
}

/** Named groups produced by AI layer naming, keyed to one traced SVG. */
export interface NamedLayout {
  svg: string // the traced SVG the indices refer to
  background: number[] // path indices of the full-canvas background
  groups: Array<{ name: string; paths: number[] }>
}

export type LayerMode = 'flat' | 'color'

// ---- colors ---------------------------------------------------------------

export function parseColor(c: string): [number, number, number] | null {
  const s = c.trim().toLowerCase()
  let m = s.match(/^#([0-9a-f]{6})$/)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  m = s.match(/^#([0-9a-f]{3})$/)
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)) as [number, number, number]
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v)) as [number, number, number]
  return null
}

export function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** "#1EC83C" → "1EC83C"; anything unparseable gets a safe slug. */
function colorSlug(color: string): string {
  const rgb = parseColor(color)
  return rgb ? toHex(rgb).slice(1) : color.replace(/[^a-z0-9]+/gi, '').slice(0, 12) || 'unknown'
}

// ---- reading --------------------------------------------------------------

export function readPaths(doc: Document): TracedPath[] {
  return Array.from(doc.querySelectorAll('path')).map((el, index) => {
    let box: BBox | null
    try {
      box = bbox(transformSubpaths(parsePath(el.getAttribute('d') ?? ''), parseTransform(el.getAttribute('transform'))))
    } catch {
      box = null
    }
    return { index, el, color: normalizeColor(el.getAttribute('fill')), box }
  })
}

function hits(group: PathGroup, box: BBox | null): boolean {
  if (!box || !group.box) return true // unmeasurable ⇒ assume it overlaps
  if (!overlaps(group.box, box, TOUCH)) return false
  return group.paths.some((p) => !p.box || overlaps(p.box, box, TOUCH))
}

/**
 * Group paths by fill color without changing what the SVG looks like. Each path
 * joins the most recent group of its color unless doing so would move it under
 * a later path it overlaps; then it starts a new group of that color.
 */
export function groupByColor(paths: TracedPath[]): PathGroup[] {
  const groups: PathGroup[] = []
  for (const p of paths) {
    let target: PathGroup | null = null
    for (let k = groups.length - 1; k >= 0; k--) {
      if (groups[k].color === p.color) {
        target = groups[k]
        break
      }
      if (hits(groups[k], p.box)) break
    }
    if (target) {
      target.paths.push(p)
      target.box = target.box && p.box ? union(target.box, p.box) : null
    } else {
      groups.push({ color: p.color, paths: [p], box: p.box })
    }
  }
  return groups
}

// ---- spatial objects (input to AI naming) ---------------------------------

export interface TracedObject {
  id: number
  paths: TracedPath[]
  box: BBox
  colors: string[] // most-used first
}

/**
 * Split the drawing into a background (full-canvas shapes at the bottom of the
 * stack) and "objects": clusters of paths whose boxes overlap. Objects never
 * overlap each other, so they can be regrouped in any order.
 */
export function findObjects(
  paths: TracedPath[],
  width: number,
  height: number,
): { background: TracedPath[]; objects: TracedObject[] } {
  const background: TracedPath[] = []
  let start = 0
  for (; start < paths.length; start++) {
    const b = paths[start].box
    if (!b || b.maxX - b.minX < width * 0.95 || b.maxY - b.minY < height * 0.95) break
    background.push(paths[start])
  }

  const rest = paths.slice(start)
  // union-find over overlapping boxes, sweep-and-prune on x
  const parent = rest.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const unmeasured: number[] = []
  const order = rest
    .map((p, i) => [p, i] as const)
    .filter(([p, i]) => (p.box ? true : (unmeasured.push(i), false)))
    .sort((a, b) => a[0].box!.minX - b[0].box!.minX)
  for (let a = 0; a < order.length; a++) {
    const [pa, ia] = order[a]
    for (let b = a + 1; b < order.length && order[b][0].box!.minX - TOUCH < pa.box!.maxX; b++) {
      const [pb, ib] = order[b]
      if (overlaps(pa.box!, pb.box!, TOUCH)) parent[find(ib)] = find(ia)
    }
  }
  // a path we couldn't measure might overlap anything, so nothing may be
  // reordered around it: everything becomes one object
  if (unmeasured.length) for (let i = 1; i < rest.length; i++) parent[find(i)] = find(0)

  const clusters = new Map<number, TracedPath[]>()
  rest.forEach((p, i) => {
    const root = find(i)
    const list = clusters.get(root)
    if (list) list.push(p)
    else clusters.set(root, [p])
  })

  const objects = [...clusters.values()].map((ps, id) => {
    const counts = new Map<string, number>()
    let box: BBox | null = null
    for (const p of ps) {
      counts.set(p.color, (counts.get(p.color) ?? 0) + 1)
      if (p.box) box = box ? union(box, p.box) : p.box
    }
    return {
      id,
      paths: ps,
      box: box ?? { minX: 0, minY: 0, maxX: width, maxY: height },
      colors: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
    }
  })
  return { background, objects }
}

// ---- export ---------------------------------------------------------------

function makeGroup(doc: Document, id: string, children: Element[]): Element {
  const g = doc.createElementNS(SVG_NS, 'g')
  g.setAttribute('id', id)
  for (const c of children) g.appendChild(c)
  return g
}

/** Build color sub-groups with unique ids `${prefix}${HEX}` / `${prefix}${HEX}-2`. */
function colorGroups(doc: Document, paths: TracedPath[], prefix: string, used: Map<string, number>): Element[] {
  return groupByColor(paths).map((g) => {
    const base = prefix + colorSlug(g.color)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return makeGroup(doc, n === 1 ? base : `${base}-${n}`, g.paths.map((p) => p.el))
  })
}

function uniqueName(name: string, used: Map<string, number>): string {
  const n = (used.get(name) ?? 0) + 1
  used.set(name, n)
  return n === 1 ? name : `${name}-${n}`
}

export interface ExportOptions {
  hiddenColors: Set<string>
  mode: LayerMode
  /** Color key of the detected background layer (named "background" in export). */
  backgroundColor?: string | null
  /** AI layout for this exact SVG; takes precedence over `mode`. */
  named?: NamedLayout | null
}

/**
 * The SVG that gets downloaded: hidden layers removed, a viewBox guaranteed and,
 * unless `mode` is 'flat', paths wrapped in named layer groups.
 */
export function buildExportSvg(svg: string, opts: ExportOptions): string {
  const doc = parser.parseFromString(svg, 'image/svg+xml')
  const svgEl = doc.querySelector('svg')
  if (!svgEl) return svg
  ensureViewBox(svgEl)

  const all = readPaths(doc)
  for (const p of all) if (opts.hiddenColors.has(p.color)) p.el.remove()
  const visible = all.filter((p) => !opts.hiddenColors.has(p.color))

  const named = opts.named && opts.named.svg === svg ? opts.named : null
  if (!named && opts.mode === 'flat') return serializer.serializeToString(svgEl)

  for (const p of visible) p.el.remove()
  const used = new Map<string, number>()
  let layers: Element[]

  if (named) {
    const keep = (idx: number[]) => idx.map((i) => all[i]).filter((p) => !opts.hiddenColors.has(p.color))
    const bg = keep(named.background)
    layers = bg.length ? [makeGroup(doc, uniqueName('background', used), bg.map((p) => p.el))] : []
    for (const group of named.groups) {
      const paths = keep(group.paths)
      if (!paths.length) continue
      const name = uniqueName(group.name, used)
      const subs = colorGroups(doc, paths, `${name}-`, used)
      // one color ⇒ skip the extra nesting level, the group itself is the layer
      layers.push(subs.length === 1 ? (subs[0].setAttribute('id', name), subs[0]) : makeGroup(doc, name, subs))
    }
    // never drop a path the layout missed
    const placed = new Set([...named.background, ...named.groups.flatMap((g) => g.paths)])
    const leftover = visible.filter((p) => !placed.has(p.index))
    if (leftover.length) layers.push(...colorGroups(doc, leftover, 'other-', used))
  } else {
    layers = colorGroups(doc, visible, 'color-', used)
    // a bottom-most group in the background color is the background itself
    if (opts.backgroundColor && visible[0]?.color === opts.backgroundColor) {
      layers[0].setAttribute('id', uniqueName('background', used))
    }
  }

  for (const g of layers) svgEl.appendChild(g)
  return serializer.serializeToString(svgEl)
}
