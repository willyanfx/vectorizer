import { useEffect, useMemo, useState } from 'react'
import { DropZone } from './components/DropZone'
import { ParamsPanel } from './components/ParamsPanel'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { useTracer } from './hooks/useTracer'
import { useDebounce } from './hooks/useDebounce'
import { DEFAULT_PARAMS, type TraceParams } from './lib/params'
import { DEFAULT_PREPROCESS, type PreprocessOptions } from './gpu'
import styles from './App.module.css'

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [params, setParams] = useState<TraceParams>(DEFAULT_PARAMS)
  const [preprocess, setPreprocess] = useState<PreprocessOptions>(DEFAULT_PREPROCESS)

  const { state, runTrace } = useTracer()

  // debounce params + preprocessing so dragging a slider doesn't spam the worker
  const debouncedParams = useDebounce(params, 300)
  const debouncedPre = useDebounce(preprocess, 300)

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

  // re-trace whenever file or (debounced) settings change
  useEffect(() => {
    if (!file) return
    void runTrace(file, debouncedParams, debouncedPre)
  }, [file, debouncedParams, debouncedPre, runTrace])

  const busy = state.status === 'preprocessing' || state.status === 'tracing'
  const hasImage = !!file

  const sidebar = useMemo(
    () => (
      <ParamsPanel
        params={params}
        onParams={setParams}
        preprocess={preprocess}
        onPreprocess={setPreprocess}
        backend={state.backend}
        disabled={!hasImage}
      />
    ),
    [params, preprocess, state.backend, hasImage],
  )

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo}>◆</span>
          <h1>Vector</h1>
          <span className={styles.tagline}>raster → SVG, in your browser</span>
        </div>
        {hasImage && (
          <button className={styles.newBtn} onClick={() => setFile(null)}>
            New image
          </button>
        )}
      </header>

      <main className={styles.main}>
        <aside className={styles.sidebar}>
          {!hasImage ? <DropZone onFile={setFile} /> : sidebar}
        </aside>

        <section className={styles.preview}>
          <PreviewPane originalUrl={originalUrl} svg={state.svg} busy={busy} />
          <StatusBar state={state} fileName={file?.name ?? null} />
        </section>
      </main>
    </div>
  )
}
