import { useCallback, useEffect, useMemo, useState } from 'react'
import { DropZone } from './components/DropZone'
import { ParamsPanel } from './components/ParamsPanel'
import { OptimizePanel } from './components/OptimizePanel'
import { VectorToggles } from './components/VectorToggles'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { useTracer } from './hooks/useTracer'
import { useDebounce } from './hooks/useDebounce'
import { useOptimize } from './hooks/useOptimize'
import { DEFAULT_PARAMS, type TraceParams } from './lib/params'
import { DEFAULT_OPTIMIZE, type OptimizeOptions } from './lib/optimize'
import {
  applyView,
  parseSvg,
  type BackgroundMode,
  type RenderStyle,
  type VectorViewOptions,
} from './lib/vectorView'
import { DEFAULT_PREPROCESS, type PreprocessOptions } from './gpu'
import styles from './App.module.css'

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [params, setParams] = useState<TraceParams>(DEFAULT_PARAMS)
  const [preprocess, setPreprocess] = useState<PreprocessOptions>(DEFAULT_PREPROCESS)
  const [optimizeOpts, setOptimizeOpts] = useState<OptimizeOptions>(DEFAULT_OPTIMIZE)

  // vector view state
  const [render, setRender] = useState<RenderStyle>('fill')
  const [background, setBackground] = useState<BackgroundMode>('checker')
  const [customBg, setCustomBg] = useState('#888888')
  const [hiddenColors, setHiddenColors] = useState<Set<string>>(new Set())

  const { state, runTrace } = useTracer()

  const debouncedParams = useDebounce(params, 300)
  const debouncedPre = useDebounce(preprocess, 300)
  const debouncedOptimize = useDebounce(optimizeOpts, 300)

  // object URL for the original image preview
  useEffect(() => {
    if (!file) {
      setOriginalUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setOriginalUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // re-trace when file or settings change
  useEffect(() => {
    if (!file) return
    void runTrace(file, debouncedParams, debouncedPre)
  }, [file, debouncedParams, debouncedPre, runTrace])

  // reset hidden layers whenever a new SVG arrives (colors may differ)
  useEffect(() => {
    setHiddenColors(new Set())
  }, [state.svg])

  // enumerate color layers from the current SVG
  const layers = useMemo(() => {
    if (!state.svg) return []
    try {
      return parseSvg(state.svg).layers
    } catch {
      return []
    }
  }, [state.svg])

  const viewOptions: VectorViewOptions = useMemo(
    () => ({ render, hiddenColors }),
    [render, hiddenColors],
  )

  // The SVG actually exported: layer visibility applied, but always FILL render
  // (outline/nodes are inspection-only views, not export styles).
  const exportSvg = useMemo(() => {
    if (!state.svg) return null
    if (hiddenColors.size === 0) return state.svg
    try {
      return applyView(state.svg, { render: 'fill', hiddenColors })
    } catch {
      return state.svg
    }
  }, [state.svg, hiddenColors])

  // Live optimization runs on the export SVG (so it reflects layer visibility).
  const optimize = useOptimize(exportSvg, debouncedOptimize)

  const toggleColor = useCallback((color: string) => {
    setHiddenColors((prev) => {
      const next = new Set(prev)
      if (next.has(color)) next.delete(color)
      else next.add(color)
      return next
    })
  }, [])
  const showAll = useCallback(() => setHiddenColors(new Set()), [])
  const hideAll = useCallback(
    () => setHiddenColors(new Set(layers.map((l) => l.color))),
    [layers],
  )

  const busy = state.status === 'preprocessing' || state.status === 'tracing'
  const hasImage = !!file
  const hasResult = !!state.svg

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo}>◆</span>
          <h1>
            Vector
            <span className={styles.srOnly}>
              {' '}— free image to SVG converter: convert PNG, JPG, WebP, GIF and
              BMP to scalable SVG vectors in your browser
            </span>
          </h1>
          <span className={styles.tagline}>raster → SVG, in your browser</span>
        </div>
        <div className={styles.headerActions}>
          {hasImage && (
            <button className={styles.newBtn} onClick={() => setFile(null)}>
              New image
            </button>
          )}
        </div>
      </header>

      <main className={styles.main}>
        <aside className={styles.sidebar}>
          {!hasImage ? (
            <DropZone onFile={setFile} />
          ) : (
            <>
              <ParamsPanel
                params={params}
                onParams={setParams}
                preprocess={preprocess}
                onPreprocess={setPreprocess}
                backend={state.backend}
                disabled={!hasImage}
              />
              <hr className={styles.divider} />
              <VectorToggles
                render={render}
                onRender={setRender}
                background={background}
                onBackground={setBackground}
                customBg={customBg}
                onCustomBg={setCustomBg}
                layers={layers}
                hiddenColors={hiddenColors}
                onToggleColor={toggleColor}
                onShowAll={showAll}
                onHideAll={hideAll}
                disabled={!hasResult}
              />
              <hr className={styles.divider} />
              <OptimizePanel
                options={optimizeOpts}
                onOptions={setOptimizeOpts}
                rawSize={optimize.rawSize}
                optimizedSize={optimize.optimizedSize}
                savedPct={optimize.savedPct}
                optimizing={optimize.optimizing}
                disabled={!hasResult}
              />
            </>
          )}
        </aside>

        <section className={styles.preview}>
          <PreviewPane
            originalUrl={originalUrl}
            svg={state.svg}
            busy={busy}
            viewOptions={viewOptions}
            background={background}
            customBg={customBg}
          />
          <StatusBar
            state={state}
            optimize={optimize}
            fileName={file?.name ?? null}
            exportSvg={exportSvg}
            exportOptimizedSvg={optimize.optimized}
          />
        </section>
      </main>
    </div>
  )
}
