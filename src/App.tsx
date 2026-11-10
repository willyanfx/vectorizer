import { useCallback, useEffect, useMemo, useState } from 'react'
import { DropZone } from './components/DropZone'
import { ParamsPanel } from './components/ParamsPanel'
import { OptimizePanel } from './components/OptimizePanel'
import { VectorToggles } from './components/VectorToggles'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { XdPanel } from './components/XdPanel'
import { isXdFile, parseXd, setXdImageScale, toDisplaySvg, type XdDocument } from './lib/xd'
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

  // Adobe XD mode: artboards are converted directly, no tracing.
  const [xd, setXd] = useState<XdDocument | null>(null)
  const [xdCurrent, setXdCurrent] = useState(0)
  const [xdSelected, setXdSelected] = useState<Set<number>>(new Set())
  const [xdStatus, setXdStatus] = useState<{ loading: string | null; error: string | null }>({
    loading: null,
    error: null,
  })

  const [xdImageBusy, setXdImageBusy] = useState<string | null>(null)

  const { state, runTrace } = useTracer()

  const openFile = useCallback(async (f: File) => {
    if (!isXdFile(f)) {
      setXd(null)
      setFile(f)
      return
    }
    setFile(null)
    setXdStatus({ loading: 'Reading XD file…', error: null })
    try {
      const doc = await parseXd(f, {
        onProgress: (msg) => setXdStatus({ loading: msg, error: null }),
      })
      setXd(doc)
      setXdCurrent(0)
      setXdSelected(new Set(doc.artboards.map((_, i) => i)))
      setXdStatus({ loading: null, error: null })
    } catch (e) {
      setXd(null)
      setXdStatus({ loading: null, error: e instanceof Error ? e.message : String(e) })
    }
  }, [])

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
    setFile(null)
    setXd(null)
    setXdStatus({ loading: null, error: null })
  }, [])

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
    setFile(new File([blob], name, { type: blob.type }))
    setXd(null)
  }, [xd])

  const xdBoard = xd?.artboards[xdCurrent] ?? null
  const xdDisplaySvg = useMemo(() => (xdBoard ? toDisplaySvg(xdBoard.svg) : null), [xdBoard])

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
              onCurrent={setXdCurrent}
              selected={xdSelected}
              onSelected={setXdSelected}
              onTracePreview={xd.previewUrl ? () => void traceXdPreview() : undefined}
              onImageScale={(s) => void changeXdImageScale(s)}
              imageBusy={xdImageBusy}
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
          {hasXd ? (
            <PreviewPane
              originalUrl={null}
              svg={xdDisplaySvg}
              busy={false}
              viewOptions={viewOptions}
              background={background}
              customBg={customBg}
              passthrough
            />
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
