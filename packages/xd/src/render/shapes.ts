import { imageHref, nodeAttrs, paintAttrs, uid, type Ctx } from './context'
import { esc, fmt, n, type Json } from '../util'

/* ------------------------------------------------------------------ shapes */

export function rectPath(x: number, y: number, w: number, h: number, r: number[]): string {
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
export function geometry(shape: Json): { el: string; box: [number, number, number, number] } | null {
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

export function pathGeometry(shape: Json): { el: string; box: [number, number, number, number] } | null {
  if (typeof shape?.path !== 'string' || !shape.path) return null
  const rule = shape.fillRule === 'evenodd' || shape.winding === 'evenodd' ? ' fill-rule="evenodd"' : ''
  return { el: `<path d="${esc(shape.path)}"${rule}`, box: pathBox(shape) }
}

/** Approximate bbox of an XD path (XD writes absolute M/L/C/Z commands). */
export function pathBox(shape: Json): [number, number, number, number] {
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

export function renderShape(ctx: Ctx, node: Json): string {
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
