// Golden render output for the fixtures in test/fixtures/. The Rust port
// (crates/xd-core/tests/golden.rs) checks the same files, so both renderers
// stay byte-identical. After an intended rendering change:
//   npm run golden -w @vector/xd

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseXd } from '../src'
import { FIXTURES } from './fixture'

const DIR = new URL('./fixtures/', import.meta.url)
const UPDATE = !!process.env.UPDATE_GOLDEN

/** Everything parseXd returns that the Rust port also produces. */
async function render(bytes: Uint8Array) {
  const doc = await parseXd(new File([bytes as BlobPart], 'fixture.xd'), { imageScale: 0 })
  return {
    artboards: doc.artboards,
    imageScale: doc.imageScale,
    imageUris: Object.fromEntries(doc.imageUris),
    imageNeeds: Object.fromEntries(doc.source.imageNeeds),
    preview: doc.previewUrl ? 'image/png' : null,
  }
}

describe.each(Object.entries(FIXTURES))('golden: %s', (name, build) => {
  const xdPath = new URL(`${name}.xd`, DIR)
  const goldenPath = new URL(`${name}.expected.json`, DIR)

  if (UPDATE) {
    it('writes the fixture and golden output', async () => {
      mkdirSync(DIR, { recursive: true })
      const bytes = build()
      writeFileSync(xdPath, bytes)
      writeFileSync(goldenPath, JSON.stringify(await render(bytes), null, 2) + '\n')
    })
    return
  }

  it('fixture file matches its builder', () => {
    expect(existsSync(xdPath), `missing ${name}.xd — run: npm run golden -w @vector/xd`).toBe(true)
    // Compare contents, not bytes: ZIP timestamps depend on the time zone.
    const decode = (b: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(b)).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))
    expect(decode(readFileSync(xdPath))).toEqual(decode(build()))
  })

  it('renders the golden output', async () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
    expect(await render(readFileSync(xdPath))).toEqual(golden)
  })
})
