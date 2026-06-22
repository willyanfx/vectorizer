import { useState } from 'react'
import { optimizeSvg } from '../lib/svgo-browser'
import type { TraceState } from '../hooks/useTracer'
import styles from './StatusBar.module.css'

interface Props {
  state: TraceState
  fileName: string | null
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

export function StatusBar({ state, fileName }: Props) {
  const [optimizing, setOptimizing] = useState(false)
  const baseName = fileName?.replace(/\.[^.]+$/, '') || 'vector'
  const svgSize = state.svg ? new Blob([state.svg]).size : 0

  const handleOptimized = async () => {
    if (!state.svg) return
    setOptimizing(true)
    try {
      const optimized = await optimizeSvg(state.svg)
      download(optimized, `${baseName}.min.svg`)
    } finally {
      setOptimizing(false)
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
            <span className={styles.stat}>{bytes(svgSize)}</span>
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
          className={styles.button}
          disabled={!state.svg}
          onClick={() => state.svg && download(state.svg, `${baseName}.svg`)}
        >
          Download SVG
        </button>
        <button
          className={`${styles.button} ${styles.secondary}`}
          disabled={!state.svg || optimizing}
          onClick={handleOptimized}
        >
          {optimizing ? 'Optimizing…' : 'Download optimized'}
        </button>
      </div>
    </div>
  )
}
