import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DropZone } from './components/DropZone'
import { ParamsPanel } from './components/ParamsPanel'
import { OptimizePanel } from './components/OptimizePanel'
import { VectorToggles } from './components/VectorToggles'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { LayersPanel, type AiStatus } from './components/LayersPanel'
import { Landing } from './components/Landing'
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
import { buildExportSvg, type LayerMode, type NamedLayout } from './lib/layers'
import { detectBackgroundColor, matchBackgroundLayer } from './lib/background'
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

  // background + export layer state
  const [detectedBg, setDetectedBg] = useState<{ file: File; color: string | null } | null>(null)
  const [keepBackground, setKeepBackground] = useState(true)
  const [layerMode, setLayerMode] = useState<LayerMode>('color')
  const [aiLayout, setAiLayout] = useState<NamedLayout | null>(null)
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle')
  const [aiError, setAiError] = useState<string | null>(null)

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

  // bumped on every new image so a late AI response for the old one is dropped
  const aiRequest = useRef(0)
  const loadFile = useCallback((f: File | null) => {
    aiRequest.current++
    setFile(f)
    setAiLayout(null)
    setAiStatus('idle')
    setAiError(null)
  }, [])

  // detect the background color once per image (independent of trace settings)
  useEffect(() => {
    if (!file) return
    let cancelled = false
    detectBackgroundColor(file)
      .then((color) => !cancelled && setDetectedBg({ file, color }))
      .catch(() => !cancelled && setDetectedBg({ file, color: null }))
    return () => {
      cancelled = true
    }
  }, [file])
  const backgroundColor = detectedBg?.file === file ? detectedBg.color : null

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

  // traced layer matching the detected background color
  const backgroundLayer = useMemo(
    () => matchBackgroundLayer(layers, backgroundColor),
    [layers, backgroundColor],
  )

  // what's actually hidden: user-hidden layers, plus the background when removed
  const effectiveHidden = useMemo(() => {
    if (keepBackground || !backgroundLayer) return hiddenColors
    return new Set([...hiddenColors, backgroundLayer])
  }, [hiddenColors, keepBackground, backgroundLayer])

  const viewOptions: VectorViewOptions = useMemo(
    () => ({ render, hiddenColors: effectiveHidden }),
    [render, effectiveHidden],
  )

  // AI names belong to the exact trace they were computed for
  const currentAiLayout = aiLayout && aiLayout.svg === state.svg ? aiLayout : null

  // The SVG actually exported: hidden layers removed, grouped into named layers,
  // always FILL render (outline/nodes are inspection-only views).
  const exportSvg = useMemo(() => {
    if (!state.svg) return null
    try {
      return buildExportSvg(state.svg, {
        hiddenColors: effectiveHidden,
        mode: layerMode,
        backgroundColor: backgroundLayer,
        named: currentAiLayout,
      })
    } catch (err) {
      console.warn('Layer export failed, using flat SVG:', err)
      return effectiveHidden.size ? applyView(state.svg, { render: 'fill', hiddenColors: effectiveHidden }) : state.svg
    }
  }, [state.svg, effectiveHidden, layerMode, backgroundLayer, currentAiLayout])

  // Live optimization runs on the export SVG (so it reflects layer visibility).
  const optimize = useOptimize(exportSvg, debouncedOptimize)

  const toggleColor = useCallback((color: string) => {
    // the removed background is controlled by its own toggle
    if (color === backgroundLayer && !keepBackground) {
      setKeepBackground(true)
      return
    }
    setHiddenColors((prev) => {
      const next = new Set(prev)
      if (next.has(color)) next.delete(color)
      else next.add(color)
      return next
    })
  }, [backgroundLayer, keepBackground])
  const showAll = useCallback(() => setHiddenColors(new Set()), [])
  const hideAll = useCallback(
    () => setHiddenColors(new Set(layers.map((l) => l.color))),
    [layers],
  )

  const runAi = useCallback(
    async (apiKey: string) => {
      if (!state.svg || !file) return
      const svg = state.svg
      const id = ++aiRequest.current
      setAiError(null)
      setAiStatus('preparing')
      try {
        const { nameLayers } = await import('./lib/aiNaming')
        const layout = await nameLayers(svg, file, apiKey, (p) => id === aiRequest.current && setAiStatus(p.stage))
        if (id !== aiRequest.current) return
        setAiLayout(layout)
        setAiStatus('idle')
      } catch (err) {
        if (id !== aiRequest.current) return
        setAiError(err instanceof Error ? err.message : String(err))
        setAiStatus('error')
      }
    },
    [state.svg, file],
  )
  const clearAi = useCallback(() => {
    setAiLayout(null)
    setAiStatus('idle')
  }, [])

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
            <button className={styles.newBtn} onClick={() => loadFile(null)}>
              New image
            </button>
          )}
        </div>
      </header>

      <main className={styles.main}>
        <aside className={styles.sidebar}>
          {!hasImage ? (
            <DropZone onFile={loadFile} />
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
                    hiddenColors={effectiveHidden}
                    onToggleColor={toggleColor}
                    onShowAll={showAll}
                    onHideAll={hideAll}
                    backgroundLayer={backgroundLayer}
                    keepBackground={keepBackground}
                    onKeepBackground={setKeepBackground}
                    disabled={!hasResult}
                  />
                  <hr className={styles.divider} />
                  <LayersPanel
                    mode={layerMode}
                    onMode={setLayerMode}
                    aiStatus={aiStatus}
                    aiError={aiError}
                    aiLayout={currentAiLayout}
                    aiStale={!!aiLayout && !currentAiLayout}
                    onRunAi={runAi}
                    onClearAi={clearAi}
                    disabled={!hasResult || busy}
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
          {!hasImage ? (
            <Landing />
          ) : (
            <>
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
            </>
          )}
        </section>
      </main>
    </div>
  )
}
