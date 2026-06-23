import type { TraceState } from '../hooks/useTracer'
import type { OptimizeState } from '../hooks/useOptimize'
import styles from './StatusBar.module.css'

interface Props {
  state: TraceState
  optimize: OptimizeState
  fileName: string | null
  /** SVG to export (already has view/layer visibility applied by the parent). */
  exportSvg: string | null
  /** Optimized + view-applied SVG to export. */
  exportOptimizedSvg: string | null
}

function download(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function StatusBar({ state, optimize, fileName, exportSvg, exportOptimizedSvg }: Props) {
  const baseName = fileName?.replace(/\.[^.]+$/, '') || 'vector'

  return (
    <div className={styles.bar}>
      <div className={styles.info}>
        {state.status === 'error' && <span className={styles.error}>⚠ {state.error}</span>}

        {state.status === 'preprocessing' && <span className={styles.muted}>Preprocessing…</span>}
        {state.status === 'tracing' && <span className={styles.muted}>Tracing…</span>}

        {state.status === 'done' && (
          <>
            <span className={styles.stat}>
              {state.engine === 'imagetracer' ? 'ImageTracer' : 'VTracer'}
            </span>
            {state.traceMs != null && (
              <span className={styles.stat}>trace {Math.round(state.traceMs)}ms</span>
            )}
            {state.preprocessMs != null && (
              <span className={styles.stat}>
                {state.backend === 'webgpu' ? 'GPU' : 'CPU'} prep {Math.round(state.preprocessMs)}ms
              </span>
            )}
            {optimize.optimizedSize > 0 && (
              <span className={styles.stat}>
                {bytes(optimize.optimizedSize)}
                {optimize.savedPct > 0 && (
                  <span className={styles.saved}> −{optimize.savedPct.toFixed(0)}%</span>
                )}
              </span>
            )}
          </>
        )}

        {state.usedFallback && (
          <span className={styles.warn} title={state.fallbackReason ?? ''}>
            Using CPU tracer (WebAssembly unavailable)
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <button
          className={`${styles.button} ${styles.secondary}`}
          disabled={!exportSvg}
          onClick={() => exportSvg && download(exportSvg, `${baseName}.svg`)}
        >
          Download SVG
        </button>
        <button
          className={styles.button}
          disabled={!exportOptimizedSvg || optimize.optimizing}
          onClick={() => exportOptimizedSvg && download(exportOptimizedSvg, `${baseName}.min.svg`)}
        >
          {optimize.optimizing ? 'Optimizing…' : 'Download optimized'}
        </button>
      </div>
    </div>
  )
}
