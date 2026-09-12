import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'

// base MUST match the GitHub Pages project path: https://<user>.github.io/vector/
// Override at build time with `VITE_BASE=/` for non-Pages hosts (e.g. Vercel).
const base = process.env.VITE_BASE ?? '/vectorizer/'

// Absolute public origin+path, used for canonical / og:url / og:image / sitemap.
// SEO metadata must point at the domain the app is ACTUALLY served from --
// otherwise the canonical tag hands all ranking signal to a stale copy. Set
// VITE_SITE_URL when deploying anywhere other than GitHub Pages, e.g.
//   VITE_BASE=/ VITE_SITE_URL=https://vectorize.example.com/ npm run build
// Always normalized to a single trailing slash so `%SITE_URL%sitemap.xml` joins
// correctly.
const siteUrl = (process.env.VITE_SITE_URL ?? 'https://willyanfx.github.io/vectorizer/').replace(
  /\/*$/,
  '/',
)

// Substitutes %SITE_URL% in index.html and in the public/ text assets that Vite
// copies verbatim (robots.txt, sitemap.xml) -- those bypass the HTML pipeline,
// so they are rewritten in the output bundle instead.
function siteUrlPlugin(): Plugin {
  return {
    name: 'site-url',
    transformIndexHtml(html) {
      return html.replaceAll('%SITE_URL%', siteUrl)
    },
    async generateBundle() {
      const { readFile } = await import('node:fs/promises')
      for (const name of ['robots.txt', 'sitemap.xml']) {
        const source = await readFile(new URL(`public/${name}`, import.meta.url), 'utf-8')
        this.emitFile({ type: 'asset', fileName: name, source: source.replaceAll('%SITE_URL%', siteUrl) })
      }
    },
  }
}

// No top-level-await plugin: we target es2022 (native TLA support) and only
// await inside async functions, so vite-plugin-wasm is sufficient on its own.
export default defineConfig({
  base,
  plugins: [react(), wasm(), siteUrlPlugin()],
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  build: {
    target: 'es2022',
  },
})
