// Browser-side SVG optimization. SVGO 4.x ships an ESM build that runs in the
// browser as long as we only use pure-JS plugins (no fs/path). Loaded lazily so
// the ~50KB chunk isn't in the initial bundle.

export async function optimizeSvg(svg: string): Promise<string> {
  // Use the browser ESM build, NOT the default 'svgo' entry which resolves to
  // svgo-node.js (pulls in fs/path/url and balloons to ~558KB).
  const { optimize } = await import('svgo/browser')
  const result = optimize(svg, {
    multipass: true,
    plugins: [
      'removeComments',
      'removeMetadata',
      'cleanupIds',
      'cleanupNumericValues',
      'collapseGroups',
      'mergePaths',
      'removeEmptyAttrs',
      'removeEmptyContainers',
      'convertPathData',
    ],
  })
  return result.data
}
