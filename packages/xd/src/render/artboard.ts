// Artboard discovery (manifest) and artboard → SVG.

import type { XdArtboard } from '../types'
import { mountForMeasure } from '../dom'
import { color, type Ctx } from './context'
import { renderNode } from './nodes'
import { esc, fmt, n, readJson, SVG_NS, type Json, type Unzipped } from '../util'

export interface ArtboardEntry {
  id: string
  path: string
  name: string
  bounds: Json
}

export function listArtboards(files: Unzipped, manifest: Json): ArtboardEntry[] {
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

export function indexSymbols(...roots: Json[]): Map<string, Json> {
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

export interface RenderedArtboard extends Omit<XdArtboard, 'template'> {
  imageNeeds: Map<string, { w: number; h: number }>
}

export function renderArtboard(
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
export function pasteboardVote(children: Json[], w: number, h: number, ox: number, oy: number): number {
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
export function needsPasteboardShift(defs: string[], content: string, w: number, h: number, ox: number, oy: number): boolean {
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
