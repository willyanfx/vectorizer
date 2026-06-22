import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './PreviewPane.module.css'

type View = 'original' | 'svg' | 'split'

interface Props {
  originalUrl: string | null
  svg: string | null
  busy: boolean
}

function useSvgUrl(svg: string | null): string | null {
  return useMemo(() => {
    if (!svg) return null
    return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  }, [svg])
}

export function PreviewPane({ originalUrl, svg, busy }: Props) {
  const [view, setView] = useState<View>('split')
  const [split, setSplit] = useState(0.5) // 0..1 divider position
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const svgUrl = useSvgUrl(svg)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ x: number; y: number } | null>(null)

  // revoke the object URL when it changes/unmounts
  useEffect(() => {
    return () => {
      if (svgUrl) URL.revokeObjectURL(svgUrl)
    }
  }, [svgUrl])

  const resetViewport = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom((z) => Math.min(8, Math.max(0.2, z * (e.deltaY < 0 ? 1.1 : 0.9))))
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (view === 'split') return // split divider handles its own drag
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragging.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    setPan({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y })
  }
  const onPointerUp = () => {
    dragging.current = null
  }

  // split divider drag
  const onSplitDrag = (e: React.PointerEvent) => {
    e.stopPropagation()
    const stage = stageRef.current
    if (!stage) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const rect = stage.getBoundingClientRect()
      setSplit(Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  const hasResult = !!svgUrl

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist">
          {(['original', 'svg', 'split'] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`${styles.tab} ${view === v ? styles.active : ''}`}
              onClick={() => setView(v)}
              disabled={v !== 'original' && !hasResult}
            >
              {v === 'original' ? 'Original' : v === 'svg' ? 'Vector' : 'Split'}
            </button>
          ))}
        </div>
        <div className={styles.zoomControls}>
          <button onClick={() => setZoom((z) => Math.max(0.2, z * 0.83))} aria-label="Zoom out">
            −
          </button>
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(8, z * 1.2))} aria-label="Zoom in">
            +
          </button>
          <button onClick={resetViewport} className={styles.fit}>
            Reset
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`${styles.stage} ${styles.checker}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {busy && <div className={styles.spinner} aria-label="Processing" />}

        {!originalUrl && !hasResult && (
          <p className={styles.empty}>Upload an image to begin</p>
        )}

        {/* Original */}
        {(view === 'original' || view === 'split') && originalUrl && (
          <div
            className={styles.layer}
            style={
              view === 'split'
                ? { clipPath: `inset(0 ${(1 - split) * 100}% 0 0)`, transform }
                : { transform }
            }
          >
            <img src={originalUrl} alt="Original" className={styles.media} draggable={false} />
          </div>
        )}

        {/* Vector */}
        {(view === 'svg' || view === 'split') && svgUrl && (
          <div
            className={styles.layer}
            style={
              view === 'split'
                ? { clipPath: `inset(0 0 0 ${split * 100}%)`, transform }
                : { transform }
            }
          >
            <img src={svgUrl} alt="Vector result" className={styles.media} draggable={false} />
          </div>
        )}

        {/* Split divider */}
        {view === 'split' && originalUrl && hasResult && (
          <div
            className={styles.divider}
            style={{ left: `${split * 100}%` }}
            onPointerDown={onSplitDrag}
            role="separator"
            aria-label="Drag to compare"
          >
            <span className={styles.handle}>⇄</span>
          </div>
        )}
      </div>
    </div>
  )
}
