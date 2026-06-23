// Configurable browser-side SVG optimization (SVGO 4.x browser build).
//
// Loaded lazily so the ~160KB-gzip SVGO chunk isn't in the initial bundle.
// The options here map onto SVGO plugins; `precision` controls coordinate /
// numeric rounding, which is usually the biggest size lever.

export interface OptimizeOptions {
  enabled: boolean // run optimization at all (live preview + export)
  multipass: boolean
  precision: number // decimal places for path/number data (0..8)
  removeComments: boolean
  removeMetadata: boolean
  cleanupIds: boolean
  collapseGroups: boolean
  mergePaths: boolean
  convertPathData: boolean
  removeViewBox: boolean // off by default — removing viewBox breaks scaling
}

export const DEFAULT_OPTIMIZE: OptimizeOptions = {
  enabled: true,
  multipass: true,
  precision: 3,
  removeComments: true,
  removeMetadata: true,
  cleanupIds: true,
  collapseGroups: true,
  mergePaths: true,
  convertPathData: true,
  removeViewBox: false,
}

// Build the SVGO plugin list from the toggle state. We use explicit plugin
// configs (not the 'preset-default' bundle) so each toggle maps 1:1 and nothing
// surprising runs.
function buildPlugins(opts: OptimizeOptions) {
  // SVGO's PluginConfig type isn't exported from the browser build cleanly, so
  // this is a loosely-typed array; SVGO validates names at runtime.
  const plugins: Array<string | { name: string; params?: Record<string, unknown> }> = [
    'removeDoctype',
    'removeXMLProcInst',
    'removeEmptyAttrs',
    'removeEmptyContainers',
  ]
  if (opts.removeComments) plugins.push('removeComments')
  if (opts.removeMetadata) plugins.push('removeMetadata')
  if (opts.cleanupIds) plugins.push('cleanupIds')
  if (opts.collapseGroups) plugins.push('collapseGroups')
  plugins.push({ name: 'cleanupNumericValues', params: { floatPrecision: opts.precision } })
  if (opts.convertPathData)
    plugins.push({ name: 'convertPathData', params: { floatPrecision: opts.precision } })
  if (opts.mergePaths) plugins.push('mergePaths')
  if (opts.removeViewBox) plugins.push('removeViewBox')
  return plugins
}

export async function optimizeSvg(svg: string, opts: OptimizeOptions): Promise<string> {
  if (!opts.enabled) return svg
  // Browser ESM build, NOT 'svgo' (which resolves to the Node entry and bloats).
  const { optimize } = await import('svgo/browser')
  const result = optimize(svg, {
    multipass: opts.multipass,
    plugins: buildPlugins(opts) as never,
  })
  return result.data
}

/** UTF-8 byte size of a string (what the downloaded file will weigh). */
export function svgByteSize(svg: string): number {
  return new Blob([svg]).size
}
