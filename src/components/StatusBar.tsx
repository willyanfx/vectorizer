import type { TraceState } from '../hooks/useTracer'
import type { OptimizeState } from '../hooks/useOptimize'
import { useState } from 'react'
import { downloadBlob, downloadPdf, downloadSvg } from '../lib/exportFiles'
import { svgToLottie } from '../lib/lottie'
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

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function StatusBar({ state, optimize, fileName, exportSvg, exportOptimizedSvg }: Props) {
  const baseName = fileName?.replace(/\.[^.]+$/, '') || 'vector'
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  const exportPdf = async () => {
    if (!exportSvg) return
    setPdfBusy(true)
    setPdfError(null)
    try {
      await downloadPdf([exportSvg], `${baseName}.pdf`)
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : String(e))
    } finally {
      setPdfBusy(false)
    }
  }

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

        {pdfError && <span className={styles.error}>⚠ PDF: {pdfError}</span>}

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
          title="Lottie JSON with one shape layer per SVG layer"
          onClick={() =>
            exportSvg &&
            downloadBlob(
              new Blob([JSON.stringify(svgToLottie(exportSvg, baseName))], { type: 'application/json' }),
              `${baseName}.json`,
            )
          }
        >
          Download Lottie
        </button>
        <button
          className={`${styles.button} ${styles.secondary}`}
          disabled={!exportSvg}
          onClick={() => exportSvg && downloadSvg(exportSvg, `${baseName}.svg`)}
        >
          Download SVG
        </button>
        <button
          className={`${styles.button} ${styles.secondary}`}
          disabled={!exportSvg || pdfBusy}
          onClick={exportPdf}
        >
          {pdfBusy ? 'Building PDF…' : 'Download PDF'}
        </button>
        <button
          className={styles.button}
          disabled={!exportOptimizedSvg || optimize.optimizing}
          onClick={() => exportOptimizedSvg && downloadSvg(exportOptimizedSvg, `${baseName}.min.svg`)}
        >
          {optimize.optimizing ? 'Optimizing…' : 'Download optimized'}
        </button>
      </div>
    </div>
  )
}
