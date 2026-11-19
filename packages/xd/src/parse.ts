// Adobe XD (.xd) → SVG, fully in the browser.
//
// A local .xd file is a ZIP archive. The parts we care about:
//   manifest                                       JSON: artboard list (names, bounds)
//   artwork/artboard-<id>/graphics/graphicContent.agc   JSON scene graph per artboard
//   resources/graphics/graphicContent.agc          JSON: shared gradients, clip paths,
//                                                  artboard bounds
//   resources/<uid>                                raw image bytes (pattern fills)
//
// The .agc format is undocumented, so this renderer is deliberately defensive:
// it understands the common node types (shapes, groups, text, image fills,
// gradients, strokes, drop shadows, masks) and silently skips anything else,
// counting it in `skipped` so the UI can say the result may be incomplete.
//
// Cloud documents (saved to Creative Cloud, not as a local .xd) are not ZIPs
// and cannot be read here — the user must "Save As" a local file first.

import type { ParseXdOptions, XdArtboard, XdDocument } from './types'
import { fillImages, processImages } from './images'
import { indexSymbols, listArtboards, renderArtboard } from './render/artboard'
import { readJson, sniffMime, unzipAsync } from './util'

export function isXdFile(file: File): boolean {
  return /\.xd$/i.test(file.name)
}

export async function parseXd(file: File, opts: ParseXdOptions = {}): Promise<XdDocument> {
  const { imageScale = 2, onProgress } = opts
  const data = new Uint8Array(await file.arrayBuffer())
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error(
      'This .xd file is not a local XD archive (it may be a cloud document). In Adobe XD use File → Save As… → "On your computer", then try again.',
    )
  }
  onProgress?.('Unpacking…')
  const files = await unzipAsync(data)
  const manifest = readJson(files, 'manifest')
  const shared = readJson(files, 'resources/graphics/graphicContent.agc')
  const symbols = indexSymbols(
    shared?.resources?.meta?.ux?.symbols,
    readJson(files, 'artwork/pasteboard/graphics/graphicContent.agc'),
  )

  onProgress?.('Converting artboards…')
  const rendered = listArtboards(files, manifest).map((e) => renderArtboard(files, e, shared, symbols))

  // Prepare each referenced image once, at the largest size any artboard needs.
  const needs = new Map<string, { w: number; h: number }>()
  for (const a of rendered)
    for (const [k, v] of a.imageNeeds) {
      const p = needs.get(k)
      needs.set(k, { w: Math.max(p?.w ?? 0, v.w), h: Math.max(p?.h ?? 0, v.h) })
    }
  const uris = await processImages(files, needs, imageScale, onProgress)

  const artboards: XdArtboard[] = rendered.map((a) => ({
    id: a.id,
    name: a.name,
    width: a.width,
    height: a.height,
    skipped: a.skipped,
    template: a.svg,
    svg: fillImages(a.svg, uris),
    layers: a.layers,
  }))

  const previewKey = Object.keys(files).find((k) => /(^|\/)(preview|thumbnail)\.(png|jpe?g)$/i.test(k))
  const previewUrl = previewKey
    ? URL.createObjectURL(new Blob([files[previewKey] as BlobPart], { type: sniffMime(files[previewKey]) ?? 'image/png' }))
    : null

  if (artboards.length === 0 && !previewUrl) {
    throw new Error('No artboards found in this XD file.')
  }
  return {
    name: file.name.replace(/\.xd$/i, ''),
    artboards,
    previewUrl,
    imageScale,
    imageUris: uris,
    source: { file, imageNeeds: needs },
  }
}

/** Re-process only the embedded images at a new scale; everything else is reused. */
export async function setXdImageScale(
  doc: XdDocument,
  imageScale: number,
  onProgress?: (message: string) => void,
): Promise<XdDocument> {
  const { file, imageNeeds } = doc.source
  let uris = new Map<string, string>()
  if (imageNeeds.size) {
    onProgress?.('Unpacking images…')
    const wanted = new Set([...imageNeeds.keys()].map((k) => `resources/${k}`))
    const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()), (name) => wanted.has(name))
    uris = await processImages(files, imageNeeds, imageScale, onProgress)
  }
  return {
    ...doc,
    imageScale,
    imageUris: uris,
    artboards: doc.artboards.map((a) => ({ ...a, svg: fillImages(a.template, uris) })),
  }
}

/** Display variant: drop fixed size so <img> scales from the viewBox. */
export function toDisplaySvg(svg: string): string {
  return svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, '<svg$1')
}
