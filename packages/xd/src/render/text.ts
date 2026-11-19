import { color, nodeAttrs, paintAttrs, type Ctx } from './context'
import { esc, fmt, n, type Json } from '../util'

/* -------------------------------------------------------------------- text */

export const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold|sm ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
]

export interface FontSpec {
  family?: string
  style?: string
  postscriptName?: string
  size?: number
}

export function fontAttrs(font: FontSpec | null | undefined): string {
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

export function fillAttr(c: { value: string; alpha: number } | null): string {
  return c ? ` fill="${c.value}"${c.alpha < 1 ? ` fill-opacity="${fmt(c.alpha)}"` : ''}` : ''
}

export function applyCase(s: string, mode: unknown): string {
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
export function textAnchorX(t: Json, align: unknown, xs: number[]): number | null {
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

/** A text node's ranged styles and its text as displayed. */
export function textRuns(node: Json) {
  const raw: string = node.text?.rawText ?? ''
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
  return { ranges, shown }
}

export function renderText(ctx: Ctx, node: Json): string {
  const t = node.text
  const raw: string = t?.rawText ?? ''
  const style = node.style ?? {}
  const attrs = nodeAttrs(ctx, node)
  const base = fontAttrs(style.font) + paintAttrs(ctx, style, true)
  const fontSize = n(style.font?.size, 16)
  const ls = n(style.textAttributes?.letterSpacing)
  const spacing = ls ? ` letter-spacing="${fmt((ls / 1000) * fontSize)}"` : ''

  const { ranges, shown } = textRuns(node)
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
