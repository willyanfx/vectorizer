import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { isXdFile, layerParents, parseXd, pickLayer, toDisplaySvg, toggleLayer, walkLayers, type XdLayer } from '../src'
import { ARTBOARD, basicXd } from './fixture'

const file = (bytes: Uint8Array, name = 'design.xd') => new File([bytes as BlobPart], name)

describe('parseXd', () => {
  it('reads artboards from the manifest', async () => {
    const doc = await parseXd(file(basicXd()))
    expect(doc.name).toBe('design')
    expect(doc.artboards).toHaveLength(1)
    const [a] = doc.artboards
    expect(a).toMatchObject({ id: ARTBOARD.id, name: ARTBOARD.name, width: ARTBOARD.width, height: ARTBOARD.height })
    // One unknown node type in the fixture.
    expect(a.skipped).toBe(1)
  })

  it('renders shapes, text and the artboard background', async () => {
    const [a] = (await parseXd(file(basicXd()))).artboards
    expect(a.svg).toMatch(/^<svg [^>]*width="375" height="812" viewBox="0 0 375 812"/)
    expect(a.svg).toContain('<title>Home</title>')
    expect(a.svg).toContain('<rect width="375" height="812" fill="#ffffff"/>')
    expect(a.svg).toContain('transform="translate(16 24)"')
    expect(a.svg).toContain('<rect x="0" y="0" width="343" height="120" rx="8" fill="#ff0000"/>')
    // XD's uppercase style is applied to the displayed text.
    expect(a.svg).toContain('>HELLO WORLD<')
    expect(a.svg).toContain('font-weight="700"')
  })

  it('builds a layer tree whose keys match ids in the SVG', async () => {
    const [a] = (await parseXd(file(basicXd()))).artboards
    const flat: XdLayer[] = []
    walkLayers(a.layers, (l) => flat.push(l))
    expect(flat.map((l) => [l.name, l.kind])).toEqual([
      ['Card', 'shape'],
      ['Header', 'group'],
      ['Hello world', 'text'],
    ])
    expect(flat[2].text).toBe('HELLO WORLD')
    for (const l of flat) expect(a.svg).toContain(`<g id="${l.key}"`)
  })

  it('falls back to scanning the archive when the manifest is missing', async () => {
    const doc = await parseXd(file(basicXd({ manifest: false })))
    expect(doc.artboards.map((a) => a.id)).toEqual([ARTBOARD.id])
  })

  it('ignores previews that are not PNG/JPEG (e.g. SVG with script)', async () => {
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const bytes = zipSync({ ...unzipSync(basicXd()), 'preview.png': svg })
    expect((await parseXd(file(bytes))).previewUrl).toBeNull()
  })

  it('rejects files that are not ZIP archives (cloud documents)', async () => {
    await expect(parseXd(file(new Uint8Array([1, 2, 3, 4])))).rejects.toThrow(/not a local XD archive/)
  })
})

describe('helpers', () => {
  it('isXdFile checks the extension', () => {
    expect(isXdFile(file(new Uint8Array(), 'A.XD'))).toBe(true)
    expect(isXdFile(file(new Uint8Array(), 'a.svg'))).toBe(false)
  })

  it('toDisplaySvg drops the fixed size', () => {
    expect(toDisplaySvg('<svg xmlns="x" width="10" height="20" viewBox="0 0 10 20">')).toBe(
      '<svg xmlns="x" viewBox="0 0 10 20">',
    )
  })
})

describe('layer selection', () => {
  // a ─ b ─ c
  //  └─ d
  const tree: XdLayer[] = [
    {
      key: 'a',
      name: 'a',
      kind: 'group',
      children: [
        { key: 'b', name: 'b', kind: 'group', children: [{ key: 'c', name: 'c', kind: 'shape', children: [] }] },
        { key: 'd', name: 'd', kind: 'shape', children: [] },
      ],
    },
  ]
  const parents = layerParents(tree)

  it('maps layers to parents', () => {
    expect(Object.fromEntries(parents)).toEqual({ a: null, b: 'a', c: 'b', d: 'a' })
  })

  it('click picks the top-level layer, drill goes one deeper, deep picks innermost', () => {
    const chain = ['a', 'b', 'c']
    expect(pickLayer(chain, new Set(), parents)).toBe('a')
    expect(pickLayer(chain, new Set(['a']), parents, { drill: true })).toBe('b')
    expect(pickLayer(chain, new Set(['d']), parents)).toBe('b') // sibling of the selection
    expect(pickLayer(chain, new Set(), parents, { deep: true })).toBe('c')
    expect(pickLayer([], new Set(), parents)).toBeNull()
  })

  it('shift-click toggles and drops ancestors/descendants', () => {
    expect([...toggleLayer(new Set(['a']), 'c', parents)]).toEqual(['c'])
    expect([...toggleLayer(new Set(['c', 'd']), 'd', parents)]).toEqual(['c'])
    expect([...toggleLayer(new Set(['c']), 'd', parents)].sort()).toEqual(['c', 'd'])
  })
})
