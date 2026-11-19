// Small shared helpers: unzip, JSON, escaping, number formatting, MIME sniffing.

import { unzip, type Unzipped } from 'fflate'

export type { Unzipped }

/* eslint-disable @typescript-eslint/no-explicit-any -- .agc is untyped JSON */
export type Json = any

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const td = new TextDecoder()

export function unzipAsync(data: Uint8Array, filter?: (name: string) => boolean): Promise<Unzipped> {
  return new Promise((resolve, reject) =>
    unzip(data, filter ? { filter: (f) => filter(f.name) } : {}, (err, files) =>
      err ? reject(err) : resolve(files),
    ),
  )
}

export function readJson(files: Unzipped, path: string): Json | null {
  const bytes = files[path]
  if (!bytes) return null
  try {
    return JSON.parse(td.decode(bytes))
  } catch {
    return null
  }
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
export const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

export function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  if (b[0] === 0x3c) return 'image/svg+xml' // '<'
  return null
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
