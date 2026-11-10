// Opt-in AI layer naming. The only feature that sends anything off-device: a
// downscaled copy of the source image (with numbered object outlines drawn on
// it) and a list of object boxes/colors go to the Anthropic API, using the
// user's own API key, straight from the browser.
//
// Claude only decides which objects belong together and what to call them. The
// objects themselves come from findObjects(), which guarantees they don't
// overlap, so any grouping Claude picks keeps the drawing pixel-identical.

import type Anthropic from '@anthropic-ai/sdk'
import { decodeImage } from '../gpu'
import { findObjects, readPaths, type NamedLayout, type TracedObject, type TracedPath } from './layers'

const MODEL = 'claude-opus-5-5'
const IMAGE_SIZE = 1024 // longest side of the image sent to Claude
const MAX_OBJECTS = 60 // smaller objects inherit the group of their nearest labelled neighbour

const SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          objects: { type: 'array', items: { type: 'integer' } },
        },
        required: ['name', 'objects'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
}

const SYSTEM = `You organize the layers of a vector graphic that was auto-traced from a raster image.

You get the original image with numbered outlines drawn over it, plus a JSON list of the same numbered objects (bounding boxes in the image's pixel coordinates and their fill colors). Group the objects into meaningful layers a designer would expect, and name each layer.

- Names are short kebab-case descriptions of what the layer depicts: "logo-icon", "text-heading", "tagline", "background-pattern", "left-eye".
- Group objects that form one thing: the letters of a word, the parts of an icon, a repeated pattern.
- Put every object id in exactly one group. Aim for roughly 2-12 groups; tiny specks can join the nearest larger group.`

export interface AiProgress {
  stage: 'preparing' | 'asking'
}

function kebab(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  // used as an XML id, which must start with a letter
  return /^[a-z]/.test(slug) ? slug : `layer-${slug}`.replace(/-$/, '')
}

async function annotatedImage(file: Blob, objects: TracedObject[], svgW: number, svgH: number): Promise<{ data: string; sx: number; sy: number }> {
  const bitmap = await decodeImage(file)
  try {
    const scale = Math.min(1, IMAGE_SIZE / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)

    // traced coordinates → annotated image pixels (the tracer may have resized)
    const sx = w / svgW
    const sy = h / svgH
    ctx.lineWidth = 2
    ctx.font = 'bold 13px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    for (const o of objects) {
      const x = o.box.minX * sx
      const y = o.box.minY * sy
      ctx.strokeStyle = '#ff2d7a'
      ctx.strokeRect(x, y, (o.box.maxX - o.box.minX) * sx, (o.box.maxY - o.box.minY) * sy)
      const label = String(o.id)
      const tw = ctx.measureText(label).width + 6
      ctx.fillStyle = '#ff2d7a'
      ctx.fillRect(x, y, tw, 16)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 3, y + 1)
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { data: btoa(bin), sx, sy }
  } finally {
    bitmap.close()
  }
}

function center(o: TracedObject): [number, number] {
  return [(o.box.minX + o.box.maxX) / 2, (o.box.minY + o.box.maxY) / 2]
}

export async function nameLayers(
  svg: string,
  file: Blob,
  apiKey: string,
  onProgress?: (p: AiProgress) => void,
): Promise<NamedLayout> {
  onProgress?.({ stage: 'preparing' })
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const svgEl = doc.querySelector('svg')
  const vb = (svgEl?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const svgW = vb.length === 4 ? vb[2] : parseFloat(svgEl?.getAttribute('width') ?? '0')
  const svgH = vb.length === 4 ? vb[3] : parseFloat(svgEl?.getAttribute('height') ?? '0')
  if (!(svgW > 0 && svgH > 0)) throw new Error('Traced SVG has no size')

  const paths = readPaths(doc)
  const { background, objects } = findObjects(paths, svgW, svgH)
  if (objects.length === 0) {
    return { svg, background: background.map((p) => p.index), groups: [] }
  }

  const area = (o: TracedObject) => (o.box.maxX - o.box.minX) * (o.box.maxY - o.box.minY)
  const labelled = [...objects].sort((a, b) => area(b) - area(a)).slice(0, MAX_OBJECTS)
  const { data, sx, sy } = await annotatedImage(file, labelled, svgW, svgH)
  const listing = labelled.map((o) => ({
    id: o.id,
    box: [o.box.minX * sx, o.box.minY * sy, o.box.maxX * sx, o.box.maxY * sy].map(Math.round),
    colors: o.colors.slice(0, 4),
    paths: o.paths.length,
  }))

  onProgress?.({ stage: 'asking' })
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk')
  // The key is the user's own and the request goes straight from their browser.
  const client = new AnthropicClient({ apiKey, dangerouslyAllowBrowser: true })
  let response: Anthropic.Beta.BetaMessage
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            { type: 'text', text: `Objects:\n${JSON.stringify(listing)}` },
          ],
        },
      ],
    })
  } catch (err) {
    if (err instanceof AnthropicClient.AuthenticationError) throw new Error('That API key was rejected. Check it and try again.', { cause: err })
    if (err instanceof AnthropicClient.PermissionDeniedError) throw new Error('This API key is not allowed to use this model.', { cause: err })
    if (err instanceof AnthropicClient.RateLimitError) throw new Error('Rate limited by the API. Wait a moment and try again.', { cause: err })
    if (err instanceof AnthropicClient.APIConnectionError) throw new Error('Could not reach the Anthropic API. Check your connection.', { cause: err })
    if (err instanceof AnthropicClient.APIError) throw new Error(`Anthropic API error${err.status ? ` ${err.status}` : ''}.`, { cause: err })
    throw err
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to name these layers.')
  if (response.stop_reason === 'max_tokens') throw new Error('Response was cut off; try again.')
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text
  if (!text) throw new Error('Empty response from Claude.')
  const parsed = JSON.parse(text) as { groups: Array<{ name: string; objects: number[] }> }

  return layoutFromAnswer(svg, background, objects, parsed, new Set(labelled.map((o) => o.id)))
}

/**
 * Map Claude's answer back onto objects: each object goes to the first group
 * that claims it; unclaimed or unlabelled objects follow their nearest claimed
 * neighbour. Duplicate claims and unknown ids are ignored.
 */
export function layoutFromAnswer(
  svg: string,
  background: TracedPath[],
  objects: TracedObject[],
  answer: { groups: Array<{ name: string; objects: number[] }> },
  /** Ids Claude was actually shown; claims on any other id are ignored. */
  labelled: Set<number> = new Set(objects.map((o) => o.id)),
): NamedLayout {
  const owner = new Map<number, number>() // object id → group index
  const groups = answer.groups.map((g, gi) => {
    for (const id of g.objects) if (labelled.has(id) && !owner.has(id)) owner.set(id, gi)
    return { name: kebab(g.name), objects: [] as TracedObject[] }
  })
  const claimed = objects.filter((o) => owner.has(o.id))
  for (const o of objects) {
    let gi = owner.get(o.id)
    if (gi === undefined) {
      if (!claimed.length) {
        groups.push({ name: 'artwork', objects: [] })
        claimed.push(o)
        owner.set(o.id, groups.length - 1)
        gi = groups.length - 1
      } else {
        const [cx, cy] = center(o)
        const nearest = claimed.reduce((best, c) => {
          const [x, y] = center(c)
          const [bx, by] = center(best)
          return Math.hypot(x - cx, y - cy) < Math.hypot(bx - cx, by - cy) ? c : best
        })
        gi = owner.get(nearest.id)!
      }
    }
    groups[gi].objects.push(o)
  }

  return {
    svg,
    background: background.map((p) => p.index),
    groups: groups
      .filter((g) => g.objects.length)
      .map((g) => ({
        name: g.name,
        // keep original paint order inside a group
        paths: g.objects.flatMap((o) => o.paths.map((p) => p.index)).sort((a, b) => a - b),
      }))
      // bottom-most group first, matching the original stacking
      .sort((a, b) => a.paths[0] - b.paths[0]),
  }
}
