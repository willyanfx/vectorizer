import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DropZone } from './components/DropZone'
import { ParamsPanel } from './components/ParamsPanel'
import { OptimizePanel } from './components/OptimizePanel'
import { VectorToggles } from './components/VectorToggles'
import { PreviewPane, type CanvasPicker } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { LayersPanel, type AiStatus } from './components/LayersPanel'
import { Landing } from './components/Landing'
import { XdPanel } from './components/XdPanel'
import {
  composeArtboardWithHit,
  isXdFile,
  layerParents,
  parseXd,
  pickLayer,
  setXdImageScale,
  toDisplaySvg,
  toggleLayer,
  type XdDocument,
} from './lib/xd'
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

  // Adobe XD mode: artboards are converted directly, no tracing.
  const [xd, setXd] = useState<XdDocument | null>(null)
  const [xdCurrent, setXdCurrent] = useState(0)
  const [xdSelected, setXdSelected] = useState<Set<number>>(new Set())
  const [xdStatus, setXdStatus] = useState<{ loading: string | null; error: string | null }>({
    loading: null,
    error: null,
  })

  const [xdImageBusy, setXdImageBusy] = useState<string | null>(null)
  const [xdLayerSel, setXdLayerSel] = useState<Set<string>>(new Set())
  const [xdHidden, setXdHidden] = useState<Map<string, Set<string>>>(new Map())
  /** Preview only the selected layers (cropped, as exported) instead of the whole artboard. */
  const [xdIsolate, setXdIsolate] = useState(false)

  // background + export layer state
  const [detectedBg, setDetectedBg] = useState<{ file: File; color: string | null } | null>(null)
  const [keepBackground, setKeepBackground] = useState(true)
  const [layerMode, setLayerMode] = useState<LayerMode>('color')
  const [aiLayout, setAiLayout] = useState<NamedLayout | null>(null)
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle')
  const [aiError, setAiError] = useState<string | null>(null)

  const { state, runTrace } = useTracer()

  // bumped on every new image so a late AI response for the old one is dropped
  const aiRequest = useRef(0)
  const loadFile = useCallback((f: File | null) => {
    aiRequest.current++
    setFile(f)
    setAiLayout(null)
    setAiStatus('idle')
    setAiError(null)
  }, [])

  const openFile = useCallback(async (f: File) => {
    if (!isXdFile(f)) {
      setXd(null)
      loadFile(f)
      return
    }
    loadFile(null)
    setXdStatus({ loading: 'Reading XD file…', error: null })
    try {
      const doc = await parseXd(f, {
        onProgress: (msg) => setXdStatus({ loading: msg, error: null }),
      })
      setXd(doc)
      setXdCurrent(0)
      setXdLayerSel(new Set())
      setXdHidden(new Map())
      setXdIsolate(false)
      setXdSelected(new Set(doc.artboards.map((_, i) => i)))
      setXdStatus({ loading: null, error: null })
    } catch (e) {
      setXd(null)
      setXdStatus({ loading: null, error: e instanceof Error ? e.message : String(e) })
    }
  }, [loadFile])

  const changeXdImageScale = useCallback(
    async (scale: number) => {
      if (!xd) return
      setXdImageBusy('Processing images…')
      try {
        setXd(await setXdImageScale(xd, scale, setXdImageBusy))
      } catch (e) {
        setXdStatus({ loading: null, error: e instanceof Error ? e.message : String(e) })
      } finally {
        setXdImageBusy(null)
      }
    },
    [xd],
  )

  const reset = useCallback(() => {
    loadFile(null)
    setXd(null)
    setXdStatus({ loading: null, error: null })
  }, [loadFile])

  // Release the embedded preview's object URL when the XD doc goes away. Keyed
  // on the URL, not the doc: changing image scale yields a new doc object that
  // still shares the same preview URL.
  const xdPreviewUrl = xd?.previewUrl ?? null
  useEffect(() => {
    return () => {
      if (xdPreviewUrl) URL.revokeObjectURL(xdPreviewUrl)
    }
  }, [xdPreviewUrl])

  const traceXdPreview = useCallback(async () => {
    if (!xd?.previewUrl) return
    const blob = await (await fetch(xd.previewUrl)).blob()
    const name = `${xd.name}-preview.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`
    loadFile(new File([blob], name, { type: blob.type }))
    setXd(null)
  }, [xd, loadFile])

  const xdBoard = xd?.artboards[xdCurrent] ?? null
  const xdIsolated = xdIsolate && xdLayerSel.size > 0
  const xdOnly = xdIsolated ? xdLayerSel : undefined
  const xdView = useMemo(() => {
    if (!xd || !xdBoard) return null
    try {
      const c = composeArtboardWithHit(xd, xdBoard, {
        hidden: xdHidden.get(xdBoard.id),
        only: xdOnly,
      })
      return c.svg ? { ...c, svg: toDisplaySvg(c.svg) } : null
    } catch {
      return { svg: toDisplaySvg(xdBoard.svg), hit: '', width: xdBoard.width, height: xdBoard.height }
    }
  }, [xd, xdBoard, xdHidden, xdOnly])

  const xdParents = useMemo(() => (xdBoard ? layerParents(xdBoard.layers) : null), [xdBoard])
  const xdPicker = useMemo<CanvasPicker | undefined>(() => {
    if (!xdView?.hit || !xdParents) return undefined
    return {
      hitSvg: xdView.hit,
      selected: xdLayerSel,
      resolve: (chain, how) => pickLayer(chain, xdLayerSel, xdParents, how),
      onPick: (key, additive) => {
        if (additive && key) setXdLayerSel(toggleLayer(xdLayerSel, key, xdParents))
        else if (!additive) setXdLayerSel(key ? new Set([key]) : new Set())
      },
    }
  }, [xdView, xdParents, xdLayerSel])
  // Big artboards (long web pages) need far more than 8× to reach 1:1.
  const xdMaxZoom = xdBoard ? Math.max(8, Math.max(xdBoard.width, xdBoard.height) / 200) : 8

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
  const hasXd = !!xd
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
          {(hasImage || hasXd) && (
            <button className={styles.newBtn} onClick={reset}>
              {hasXd ? 'New file' : 'New image'}
            </button>
          )}
        </div>
      </header>

      <main className={styles.main}>
        <aside className={styles.sidebar}>
          {hasXd ? (
            <XdPanel
              doc={xd}
              current={xdCurrent}
              onCurrent={(i) => {
                setXdCurrent(i)
                setXdLayerSel(new Set())
              }}
              selected={xdSelected}
              onSelected={setXdSelected}
              onTracePreview={xd.previewUrl ? () => void traceXdPreview() : undefined}
              onImageScale={(s) => void changeXdImageScale(s)}
              imageBusy={xdImageBusy}
              layerSel={xdLayerSel}
              onLayerSel={setXdLayerSel}
              hidden={xdHidden}
              onHidden={setXdHidden}
              isolate={xdIsolate}
              onIsolate={setXdIsolate}
            />
          ) : !hasImage ? (
            <>
              <DropZone onFile={(f) => void openFile(f)} disabled={!!xdStatus.loading} />
              {xdStatus.loading && (
                <p className={styles.sideNote} role="status">
                  {xdStatus.loading}
                </p>
              )}
              {xdStatus.error && <p className={styles.sideError}>⚠ {xdStatus.error}</p>}
            </>
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
          {hasXd ? (
            <PreviewPane
              key={xdBoard?.id}
              originalUrl={null}
              svg={xdView?.svg ?? null}
              busy={false}
              viewOptions={viewOptions}
              background={background}
              customBg={customBg}
              passthrough
              // Isolated, the canvas shows only the selection, so there is nothing new to click.
              picker={xdIsolated ? undefined : xdPicker}
              artSize={xdView ?? undefined}
              maxZoom={xdMaxZoom}
            />
          ) : !hasImage ? (
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
