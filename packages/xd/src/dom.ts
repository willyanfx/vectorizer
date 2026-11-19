// Browser-only helpers: these need a live, laid-out DOM.

import type { Rect } from './types'
import { SVG_NS } from './util'

/**
 * Mount a copy of an SVG off-screen so it can be measured. Image hrefs are
 * dropped from the copy: they are placeholders (or huge data URIs) and
 * <image> boxes come from x/y/width/height anyway.
 */
export function mountForMeasure(svg: Element): HTMLDivElement {
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

export function rectOf(el: Element): Rect | null {
  const r = el.getBoundingClientRect()
  return r.width || r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
}

export function intersect(a: Rect | null, b: Rect | null): Rect | null {
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
