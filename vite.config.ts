import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'

// base MUST match the GitHub Pages project path: https://<user>.github.io/vector/
// Override at build time with `VITE_BASE=/` for non-Pages hosts (e.g. Vercel).
const base = process.env.VITE_BASE ?? '/vector/'

// No top-level-await plugin: we target es2022 (native TLA support) and only
// await inside async functions, so vite-plugin-wasm is sufficient on its own.
export default defineConfig({
  base,
  plugins: [react(), wasm()],
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  build: {
    target: 'es2022',
  },
})
