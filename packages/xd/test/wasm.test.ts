// The Rust/WASM build (crates/xd-wasm) against this package, end to end.
// Skipped unless the Node build exists: npm run test:xd-wasm (from the repo root).

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { composeArtboard, parseXd } from '../src'
import { FIXTURES } from './fixture'

const PKG = new URL('../../../crates/xd-wasm/pkg-node/xd_wasm.js', import.meta.url).pathname
const built = existsSync(PKG)
const w = built ? createRequire(import.meta.url)(PKG) : null

describe.skipIf(!built)('xd-wasm', () => {
  it.each(Object.keys(FIXTURES))('parseXd matches the TS renderer: %s', async (name) => {
    const bytes = FIXTURES[name]()
    const ts = await parseXd(new File([bytes as BlobPart], 'f.xd'), { imageScale: 0 })
    const rs = w.parseXd(bytes, 0)
    expect(rs.artboards).toEqual(ts.artboards)
    expect(rs.imageUris).toEqual(ts.imageUris)
    expect(rs.imageNeeds).toEqual(ts.source.imageNeeds)
    expect(!!rs.preview).toBe(!!ts.previewUrl)
    // The Rust output plugs into the TS layer helpers unchanged.
    const doc = { ...ts, artboards: rs.artboards, imageUris: rs.imageUris }
    expect(composeArtboard(doc, rs.artboards[0]).svg).toBe(ts.artboards[0].svg)
  })

  it('re-scales images and fills templates', () => {
    const bytes = FIXTURES['kitchen-sink']()
    const doc = w.parseXd(bytes, 2)
    const uris = w.processImages(bytes, doc.imageNeeds, 2)
    expect([...uris.keys()]).toEqual(['img1', 'img2'])
    expect(w.fillImages(doc.artboards[0].template, uris)).toBe(doc.artboards[0].svg)
    expect(w.fillImages(doc.artboards[0].template)).toContain('data:image/png;base64,')
    expect(doc.preview.mime).toBe('image/png')
    expect(doc.preview.bytes).toBeInstanceOf(Uint8Array)
  })

  it('lists artboards without rendering, and rejects cloud documents', () => {
    const names = w.listArtboards(FIXTURES['kitchen-sink']()).map((a: { name: string }) => a.name)
    expect(names).toEqual(['Kitchen <sink> & "co"', 'Pasteboard coords', 'Legacy'])
    expect(() => w.parseXd(new Uint8Array([1, 2, 3]))).toThrow(/not a local XD archive/)
  })
})
