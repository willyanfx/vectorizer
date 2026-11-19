// Layer extraction: hide layers, or export only some, cropped to their bounds.

import type { ComposedSvg, ComposeOptions, XdArtboard, XdDocument } from './types'
import { mountForMeasure, visibleRect } from './dom'
import { fillImages } from './images'
import { fmt, n } from './util'

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
