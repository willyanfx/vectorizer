// Scene-graph traversal: groups, masks, component instances, scroll groups.

import type { XdLayer } from '../types'
import { nodeAttrs, transformAttr, uid, type Ctx } from './context'
import { geometry, renderShape } from './shapes'
import { renderText, textRuns } from './text'
import { fmt, n, type Json } from '../util'

/* ----------------------------------------------------------------- traverse */

export function clipFor(ctx: Ctx, node: Json): string {
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

export function layerKind(node: Json): XdLayer['kind'] {
  if (node.type === 'syncRef') return 'component'
  if (node.type === 'text') return 'text'
  if (node.type === 'shape' || (!node.group && node.shape))
    return node.style?.fill?.type === 'pattern' ? 'image' : 'shape'
  if (node.style?.clipPath?.ref || node.meta?.ux?.clipPathResources) return 'mask'
  return 'group'
}

export function layerName(node: Json, kind: XdLayer['kind']): string {
  if (kind === 'text') {
    const t = String(node.text?.rawText ?? node.name ?? '').replace(/\s+/g, ' ').trim()
    if (t) return t.length > 48 ? `${t.slice(0, 47)}…` : t
  }
  if (typeof node.name === 'string' && node.name.trim()) return node.name.trim()
  return kind[0].toUpperCase() + kind.slice(1)
}

export function renderNode(ctx: Ctx, node: Json, as?: Json): string {
  if (!node || node.visible === false) return ''
  if (ctx.depth > 64) {
    ctx.skipped++
    return ''
  }
  if (node.type === 'syncRef') {
    const src = masterOf(ctx, node)
    if (!src) {
      ctx.skipped++
      return ''
    }
    if (Array.isArray(node.group?.children)) {
      // An instance's own copy of a master group: the children are the
      // instance's (with overrides), everything else comes from the master.
      node = { ...src, group: { ...src.group, children: node.group.children } }
      if (node.visible === false) return ''
    } else {
      // A childless syncRef is a linked copy of a node inside a component master.
      ctx.depth++
      // The instance's own layer entry describes the master's node.
      const out = renderNode(ctx, src, as ?? node)
      ctx.depth--
      return out
    }
  }

  const kind = as ? 'component' : layerKind(node)
  const layer: XdLayer = {
    key: `xl${++ctx.layerIds}`,
    name: layerName(as?.name ? as : node, kind === 'component' ? layerKind(node) : kind),
    kind,
    children: [],
  }
  if (node.type === 'text') layer.text = textRuns(node).shown
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

/** Instance properties layered over the master node's (transform, style, scroll viewport…). */
export function overlay(master: Json, inst: Json): Json {
  const out: Json = { ...master }
  for (const k of ['transform', 'visible', 'name'])
    if (inst[k] !== undefined) out[k] = inst[k]
  if (inst.style) out.style = { ...master.style, ...inst.style }
  if (inst.meta?.ux) out.meta = { ...master.meta, ux: { ...master.meta?.ux, ...inst.meta.ux } }
  return out
}

/** The master node a syncRef stands for, with the syncRef's own overrides applied. */
export function masterOf(ctx: Ctx, node: Json, hops = 0): Json | null {
  const src = ctx.symbols.get(node.syncSourceGuid)
  if (!src || hops > 16) return null
  const base = src.type === 'syncRef' ? masterOf(ctx, src, hops + 1) : src
  return base && overlay(base, node)
}

/** Scroll groups show only their viewport (XD exports the unscrolled view). */
export function scrollClip(ctx: Ctx, node: Json): string {
  const ux = node.meta?.ux
  const type = ux?.scrollingType
  if (!type) return ''
  const BIG = 1e6
  const w = type === 'vertical' ? 0 : n(ux.viewportWidth)
  const h = type === 'horizontal' ? 0 : n(ux.viewportHeight)
  if (!(w > 0) && !(h > 0)) return ''
  const id = uid(ctx, 'm')
  const [x, cw] = w > 0 ? [0, w] : [-BIG / 2, BIG]
  const [y, ch] = h > 0 ? [0, h] : [-BIG / 2, BIG]
  ctx.defs.push(`<clipPath id="${id}"><rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(cw)}" height="${fmt(ch)}"/></clipPath>`)
  return ` clip-path="url(#${id})"`
}

export function renderNodeInner(ctx: Ctx, node: Json): string {
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
        const scroll = scrollClip(ctx, node)
        let inner = kids.map((k) => renderNode(ctx, k)).join('')
        if (scroll && clip) inner = `<g${scroll}>${inner}</g>`
        return `<g${nodeAttrs(ctx, node)}${clip || scroll}>${inner}</g>`
      }
      if (node.shape) return renderShape(ctx, node)
      ctx.skipped++
      return ''
    }
  }
}
