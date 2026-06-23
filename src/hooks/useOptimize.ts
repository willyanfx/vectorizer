import { useEffect, useRef, useState } from 'react'
import { optimizeSvg, svgByteSize, type OptimizeOptions } from '../lib/optimize'

export interface OptimizeState {
  optimized: string | null // optimized SVG (or raw passthrough if disabled)
  optimizing: boolean
  rawSize: number
  optimizedSize: number
  savedPct: number // 0..100
}

const EMPTY: OptimizeState = {
  optimized: null,
  optimizing: false,
  rawSize: 0,
  optimizedSize: 0,
  savedPct: 0,
}

/**
 * Runs SVG optimization live whenever `svg` or `opts` change. Optimization is
 * async (lazy SVGO import) and can be slow on big SVGs, so the result lags the
 * input by a tick; a run counter discards stale results.
 */
export function useOptimize(svg: string | null, opts: OptimizeOptions): OptimizeState {
  const [state, setState] = useState<OptimizeState>(EMPTY)
  const runId = useRef(0)

  useEffect(() => {
    if (!svg) {
      setState(EMPTY)
      return
    }
    const id = ++runId.current
    const rawSize = svgByteSize(svg)

    if (!opts.enabled) {
      setState({ optimized: svg, optimizing: false, rawSize, optimizedSize: rawSize, savedPct: 0 })
      return
    }

    setState((s) => ({ ...s, optimizing: true, rawSize }))
    void optimizeSvg(svg, opts)
      .then((out) => {
        if (id !== runId.current) return
        const optimizedSize = svgByteSize(out)
        const savedPct = rawSize > 0 ? Math.max(0, (1 - optimizedSize / rawSize) * 100) : 0
        setState({ optimized: out, optimizing: false, rawSize, optimizedSize, savedPct })
      })
      .catch((err) => {
        if (id !== runId.current) return
        console.warn('SVG optimization failed:', err)
        // fall back to raw SVG so export still works
        setState({ optimized: svg, optimizing: false, rawSize, optimizedSize: rawSize, savedPct: 0 })
      })
  }, [svg, opts])

  return state
}
