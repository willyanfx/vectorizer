// Download helpers: SVG, ZIP of SVGs, and vector PDF (one page per SVG).
// jsPDF + svg2pdf are ~400 KB, so they're loaded only when a PDF is requested.

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // The anchor must be in the document for the click to reliably start a
  // download in Firefox, and the url must outlive the click: revoking it
  // synchronously races the download in Safari/Firefox and can yield an empty
  // file. Defer the revoke (and the removal) to the next macrotask.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 0)
}

export function downloadSvg(svg: string, filename: string) {
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), filename)
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled'
}

/** Zip several SVGs; duplicate names get a numeric suffix. */
export async function downloadSvgZip(items: Array<{ name: string; svg: string }>, filename: string) {
  const { zipSync, strToU8 } = await import('fflate')
  const used = new Map<string, number>()
  const entries: Record<string, Uint8Array> = {}
  for (const { name, svg } of items) {
    const base = safeFileName(name)
    const k = used.get(base) ?? 0
    used.set(base, k + 1)
    entries[`${k ? `${base} (${k + 1})` : base}.svg`] = strToU8(svg)
  }
  const zipped = zipSync(entries, { level: 6 })
  downloadBlob(new Blob([zipped as BlobPart], { type: 'application/zip' }), filename)
}

function svgSize(el: SVGSVGElement): { w: number; h: number } {
  const vb = el.viewBox?.baseVal
  const w = parseFloat(el.getAttribute('width') ?? '') || vb?.width || 0
  const h = parseFloat(el.getAttribute('height') ?? '') || vb?.height || 0
  return { w: w || 595, h: h || 842 }
}

/**
 * Render SVGs into a multi-page vector PDF, one page per SVG sized to it
 * (1 SVG px → 1 PDF pt, the same mapping Adobe XD uses for PDF export).
 *
 * Text is kept as real text, but PDF only has the 14 standard fonts built in, so
 * custom font families fall back to Helvetica/Times/Courier.
 */
export async function svgsToPdfBlob(svgs: string[]): Promise<Blob> {
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')])
  const parser = new DOMParser()
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden'
  document.body.appendChild(host)

  try {
    let pdf: InstanceType<typeof jsPDF> | null = null
    for (const svg of svgs) {
      const parsed = parser.parseFromString(svg, 'image/svg+xml')
      if (parsed.querySelector('parsererror')) throw new Error('Could not parse SVG for PDF export')
      // svg2pdf needs a live element (for computed styles / bbox measurement).
      const el = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement
      host.replaceChildren(el)
      const { w, h } = svgSize(el)
      const orientation = w > h ? 'landscape' : 'portrait'
      if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true })
      else pdf.addPage([w, h], orientation)
      await pdf.svg(el, { x: 0, y: 0, width: w, height: h })
    }
    if (!pdf) throw new Error('Nothing to export')
    return pdf.output('blob')
  } finally {
    host.remove()
  }
}

export async function downloadPdf(svgs: string[], filename: string) {
  downloadBlob(await svgsToPdfBlob(svgs), filename)
}
