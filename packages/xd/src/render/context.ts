// Render context + paint/transform/filter attributes shared by every node type.

import type { XdLayer } from '../types'
import { esc, fmt, n, type Json, type Unzipped } from '../util'

/* ------------------------------------------------------------------ colors */

export function color(c: Json): { value: string; alpha: number } | null {
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

export interface Ctx {
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

export const uid = (ctx: Ctx, p: string) => `${p}${++ctx.ids}`

export function transformAttr(t: Json): string {
  if (!t || typeof t !== 'object') return ''
  const { a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0 } = t
  if (a === 1 && b === 0 && c === 0 && d === 1) {
    return tx || ty ? ` transform="translate(${fmt(tx)} ${fmt(ty)})"` : ''
  }
  return ` transform="matrix(${[a, b, c, d, tx, ty].map((x) => fmt(n(x))).join(' ')})"`
}

export function gradientDef(ctx: Ctx, g: Json): string | null {
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
export const IMG_TOKEN = (key: string) => `__XDIMG_${key}__`

export function imageHref(ctx: Ctx, pattern: Json, w: number, h: number): string | null {
  const key: string | undefined =
    pattern?.meta?.ux?.uid ?? (typeof pattern?.href === 'string' ? pattern.href.replace(/^\//, '') : undefined)
  if (!key || !/^[\w.-]+$/.test(key)) return null
  if (!ctx.files[`resources/${key}`]) return null
  const prev = ctx.imageNeeds.get(key)
  ctx.imageNeeds.set(key, { w: Math.max(prev?.w ?? 0, w), h: Math.max(prev?.h ?? 0, h) })
  return IMG_TOKEN(key)
}

/** fill / stroke / opacity / filter attributes for a node's style. */
export function paintAttrs(ctx: Ctx, style: Json, isText = false): string {
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

export function nodeAttrs(ctx: Ctx, node: Json): string {
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
