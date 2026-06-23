// Parse a VTracer SVG into manipulable layers and re-render it with view
// options applied (render style, background, per-color visibility).
//
// VTracer emits a flat list of <path fill="#RRGGBB" transform="..."> elements,
// one per color region. We group by fill color into "layers".

export type RenderStyle = 'fill' | 'outline' | 'nodes'
export type BackgroundMode = 'checker' | 'white' | 'black' | 'custom'

export interface VectorViewOptions {
  render: RenderStyle
  hiddenColors: Set<string> // fill colors to hide (uppercase hex)
}

export interface ColorLayer {
  color: string // uppercase hex, e.g. "#1EC83C"
  count: number // number of paths with this fill
}

export interface ParsedSvg {
  doc: Document
  svgEl: SVGSVGElement | null
  layers: ColorLayer[]
}

const parser = new DOMParser()
const serializer = new XMLSerializer()

function normalizeColor(c: string | null): string {
  if (!c) return '#000000'
  return c.trim().toUpperCase()
}

/** Parse the SVG and enumerate its color layers (grouped by fill). */
export function parseSvg(svg: string): ParsedSvg {
  const doc = parser.parseFromString(svg, 'image/svg+xml')
  const svgEl = doc.querySelector('svg')
  const counts = new Map<string, number>()
  doc.querySelectorAll('path').forEach((p) => {
    const c = normalizeColor(p.getAttribute('fill'))
    counts.set(c, (counts.get(c) ?? 0) + 1)
  })
  const layers: ColorLayer[] = [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count)
  return { doc, svgEl, layers }
}

// Extract anchor points (absolute) from a path `d` for the "nodes" view. This is
// a lightweight pass over M/L/C/S/Q/T command coordinates — enough to dot the
// curve anchors without a full SVG path math library.
function anchorPoints(d: string): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  // commands followed by number runs; we read absolute coords for uppercase cmds
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g)
  if (!tokens) return pts
  let i = 0
  let cur: [number, number] = [0, 0]
  const num = () => parseFloat(tokens[i++])
  while (i < tokens.length) {
    const cmd = tokens[i++]
    switch (cmd) {
      case 'M':
      case 'L':
      case 'T': {
        cur = [num(), num()]
        pts.push(cur)
        break
      }
      case 'C': {
        num(); num(); num(); num() // two control points
        cur = [num(), num()]
        pts.push(cur)
        break
      }
      case 'S':
      case 'Q': {
        num(); num()
        cur = [num(), num()]
        pts.push(cur)
        break
      }
      case 'Z':
      case 'z':
        break
      // relative / other commands: skip their numbers conservatively
      default:
        // consume any stray numbers belonging to unsupported commands
        while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) i++
        break
    }
  }
  return pts
}

/**
 * Re-render the SVG string with view options applied. Returns a new SVG string
 * suitable for inlining. Does NOT mutate the input.
 */
export function applyView(svg: string, opts: VectorViewOptions): string {
  const { doc, svgEl } = parseSvg(svg)
  if (!svgEl) return svg

  const paths = Array.from(doc.querySelectorAll('path'))
  const nodeDots: SVGCircleElement[] = []

  for (const p of paths) {
    const color = normalizeColor(p.getAttribute('fill'))
    const hidden = opts.hiddenColors.has(color)
    if (hidden) {
      p.setAttribute('display', 'none')
      continue
    }
    p.removeAttribute('display')

    if (opts.render === 'outline') {
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', color)
      p.setAttribute('stroke-width', '0.4')
      p.setAttribute('vector-effect', 'non-scaling-stroke')
    } else if (opts.render === 'nodes') {
      // keep faint fill, overlay node dots
      p.setAttribute('fill', color)
      p.setAttribute('fill-opacity', '0.25')
      const transform = p.getAttribute('transform') ?? ''
      const d = p.getAttribute('d') ?? ''
      for (const [x, y] of anchorPoints(d)) {
        const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(x))
        dot.setAttribute('cy', String(y))
        dot.setAttribute('r', '0.6')
        dot.setAttribute('fill', '#ff3b6b')
        if (transform) dot.setAttribute('transform', transform)
        dot.setAttribute('vector-effect', 'non-scaling-stroke')
        nodeDots.push(dot)
      }
    } else {
      // fill (default): ensure original fill restored
      p.setAttribute('fill', color)
      p.removeAttribute('fill-opacity')
      p.removeAttribute('stroke')
    }
  }

  for (const dot of nodeDots) svgEl.appendChild(dot)
  return serializer.serializeToString(svgEl)
}
