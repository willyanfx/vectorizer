import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyView, type BackgroundMode, type VectorViewOptions } from '../lib/vectorView'
import { visibleRect } from '../lib/xd'
import styles from './PreviewPane.module.css'

type View = 'original' | 'svg' | 'split'

/** Click-to-select on the canvas (Adobe XD artboards). */
export interface CanvasPicker {
  /** Same geometry and layer ids as the displayed SVG, images blanked out. */
  hitSvg: string
  selected: ReadonlySet<string>
  /** Layer a click would pick, given the layer ids under the pointer (outermost first). */
  resolve: (chain: string[], how: { deep: boolean; drill: boolean }) => string | null
  /** null clears the selection; `additive` toggles the layer in the selection. */
  onPick: (key: string | null, additive: boolean) => void
}

interface Props {
  originalUrl: string | null
  svg: string | null
  busy: boolean
  viewOptions: VectorViewOptions
  background: BackgroundMode
  customBg: string
  /** Show the SVG as-is (skip tracer view options). Used for Adobe XD artboards. */
  passthrough?: boolean
  /**
   * Artwork size. When set, the SVG is shown in a box of this aspect ratio that
   * zooms by resizing (sharp at any zoom), and `picker` can be used.
   */
  artSize?: { width: number; height: number }
  picker?: CanvasPicker
  maxZoom?: number
}

const MIN_ZOOM = 0.2
/** Pointer travel (px) below which a press counts as a click, not a pan. */
const CLICK_SLOP = 4
const DOUBLE_CLICK_MS = 350
const LAYER_ID = /^xl\d+$/

/** A box as fractions of the canvas box, so it scales with zoom for free. */
type Box = { x: number; y: number; w: number; h: number }

// The SVG is inlined (not <img>) so render/visibility toggles can manipulate its
// paths. We apply the view options to the SVG string and inject the result.
function useViewedSvgUrl(
  svg: string | null,
  opts: VectorViewOptions,
  passthrough: boolean,
): string | null {
  return useMemo(() => {
    if (!svg) return null
    let out: string
    try {
      out = passthrough ? svg : applyView(svg, opts, true)
    } catch {
      out = svg
    }
    return URL.createObjectURL(new Blob([out], { type: 'image/svg+xml' }))
  }, [svg, opts, passthrough])
}

export function PreviewPane({
  originalUrl,
  svg,
  busy,
  viewOptions,
  background,
  customBg,
  passthrough = false,
  artSize,
  picker,
  maxZoom = 8,
}: Props) {
  const [selectedView, setView] = useState<View>('split')
  // Nothing to compare against without an original: show the vector alone.
  const view: View = originalUrl ? selectedView : 'svg'
  const [split, setSplit] = useState(0.5)
  const [vp, setVp] = useState({ zoom: 1, x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const svgUrl = useViewedSvgUrl(svg, viewOptions, passthrough)
  const stageRef = useRef<HTMLDivElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null)
  const lastClick = useRef<{ t: number; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Box | null>(null)
  const [selBoxes, setSelBoxes] = useState<Box[]>([])

  // Revoke a URL once it's no longer shown. Deferred, because StrictMode's
  // simulated unmount runs this cleanup and then reuses the very same URL.
  const liveUrls = useRef(new Set<string>())
  useEffect(() => {
    if (!svgUrl) return
    const live = liveUrls.current
    live.add(svgUrl)
    return () => {
      live.delete(svgUrl)
      setTimeout(() => !live.has(svgUrl) && URL.revokeObjectURL(svgUrl), 0)
    }
  }, [svgUrl])

  const resetViewport = useCallback(() => setVp({ zoom: 1, x: 0, y: 0 }), [])

  /** Zoom by `factor`, keeping the point at (cx, cy) client px fixed (stage centre by default). */
  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const rect = stageRef.current?.getBoundingClientRect()
      const px = rect && cx != null ? cx - rect.left - rect.width / 2 : 0
      const py = rect && cy != null ? cy - rect.top - rect.height / 2 : 0
      setVp((v) => {
        const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, v.zoom * factor))
        const k = zoom / v.zoom
        return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    },
    [maxZoom],
  )

  // Native listener: React's wheel handler is passive, so it can't stop the page scrolling.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Mouse wheels step ~100 per notch, trackpads send many small deltas.
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  /* ------------------------------------------------------------ picking */

  /** Layer ids under a client point, outermost first. */
  const chainAt = useCallback((x: number, y: number): string[] => {
    const host = hitRef.current
    const el = host && document.elementFromPoint(x, y)
    if (!host || !el || !host.contains(el)) return []
    const chain: string[] = []
    for (let p: Element | null = el; p && p !== host; p = p.parentElement) if (LAYER_ID.test(p.id)) chain.unshift(p.id)
    return chain
  }, [])

  /** Box of a layer as fractions of the canvas box. */
  const boxOf = useCallback((key: string): Box | null => {
    const host = hitRef.current
    const root = host?.querySelector('svg')
    const el = root?.querySelector(`[id="${CSS.escape(key)}"]`)
    if (!host || !root || !el) return null
    const r = visibleRect(root, el)
    const b = host.getBoundingClientRect()
    if (!r || !b.width || !b.height) return null
    return {
      x: (r.left - b.left) / b.width,
      y: (r.top - b.top) / b.height,
      w: (r.right - r.left) / b.width,
      h: (r.bottom - r.top) / b.height,
    }
  }, [])

  const hitSvg = picker?.hitSvg
  const selected = picker?.selected
  // Fractions don't change with zoom or pan, so only re-measure on new content or selection.
  useLayoutEffect(() => {
    if (!hitSvg || !selected) return
    // Reading layout from the DOM is what layout effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelBoxes([...selected].map(boxOf).filter((b): b is Box => !!b))
  }, [hitSvg, selected, boxOf])

  const hoverKey = useRef<string | null>(null)
  const updateHover = (e: React.PointerEvent) => {
    if (!picker) return
    const key = picker.resolve(chainAt(e.clientX, e.clientY), { deep: e.metaKey || e.ctrlKey, drill: false })
    if (key === hoverKey.current) return
    hoverKey.current = key
    setHover(key && !picker.selected.has(key) ? boxOf(key) : null)
  }
  const clearHover = () => {
    hoverKey.current = null
    setHover(null)
  }

  const click = (e: React.PointerEvent) => {
    if (!picker) return
    const now = performance.now()
    const prev = lastClick.current
    const drill =
      !!prev && now - prev.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < CLICK_SLOP * 2
    lastClick.current = drill ? null : { t: now, x: e.clientX, y: e.clientY }
    const key = picker.resolve(chainAt(e.clientX, e.clientY), { deep: e.metaKey || e.ctrlKey, drill })
    if (!key && e.shiftKey) return // shift-click on empty space keeps the selection
    picker.onPick(key, e.shiftKey)
    clearHover()
  }

  const onPick = picker?.onPick
  useEffect(() => {
    if (!onPick) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== 'Escape' || t?.closest('input, textarea, select, [contenteditable="true"]')) return
      onPick(null, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPick])

  /* --------------------------------------------------------- pan / click */

  const onPointerDown = (e: React.PointerEvent) => {
    if (view === 'split' || e.button !== 0) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    press.current = { x: e.clientX, y: e.clientY, panX: vp.x, panY: vp.y, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current
    if (!p) {
      updateHover(e)
      return
    }
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < CLICK_SLOP) return
    if (!p.moved) {
      p.moved = true
      setPanning(true)
      clearHover()
    }
    setVp((v) => ({ ...v, x: p.panX + e.clientX - p.x, y: p.panY + e.clientY - p.y }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current
    press.current = null
    setPanning(false)
    if (p && !p.moved) click(e)
  }

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

  const transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`
  const hasResult = !!svgUrl

  // background style for the stage
  const stageBg: React.CSSProperties =
    background === 'white'
      ? { background: '#ffffff' }
      : background === 'black'
        ? { background: '#000000' }
        : background === 'custom'
          ? { background: customBg }
          : {}
  const stageClass = [
    styles.stage,
    background === 'checker' && styles.checker,
    picker && styles.picking,
    panning && styles.panning,
  ]
    .filter(Boolean)
    .join(' ')

  const ratio = artSize && artSize.width > 0 && artSize.height > 0 ? artSize.width / artSize.height : null
  // The XD canvas zooms by resizing its box rather than scaling it, so the SVG
  // is redrawn at the real size and stays sharp at any zoom (a CSS scale would
  // just stretch the small bitmap — very blurry on tall artboards at 50×).
  const canvasStyle: React.CSSProperties | undefined = ratio
    ? { aspectRatio: String(ratio), width: `calc(min(92cqw, 92cqh * ${ratio}) * ${vp.zoom})` }
    : undefined
  const pct = (b: Box): React.CSSProperties => ({
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.w * 100}%`,
    height: `${b.h * 100}%`,
  })

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
              disabled={
                v === 'original' ? !originalUrl : v === 'svg' ? !hasResult : !hasResult || !originalUrl
              }
            >
              {v === 'original' ? 'Original' : v === 'svg' ? 'Vector' : 'Split'}
            </button>
          ))}
        </div>
        <div className={styles.zoomControls}>
          <button onClick={() => zoomBy(0.83)} aria-label="Zoom out">
            −
          </button>
          <span className={styles.zoomLabel}>{Math.round(vp.zoom * 100)}%</span>
          <button onClick={() => zoomBy(1.2)} aria-label="Zoom in">
            +
          </button>
          <button onClick={resetViewport} className={styles.fit}>
            Reset
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={stageClass}
        style={stageBg}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null
          setPanning(false)
        }}
        onPointerLeave={clearHover}
      >
        {busy && <div className={styles.spinner} aria-label="Processing" />}

        {!originalUrl && !hasResult && <p className={styles.empty}>Upload an image to begin</p>}

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

        {(view === 'svg' || view === 'split') && svgUrl && (
          <div
            className={`${styles.layer} ${ratio ? styles.sized : ''}`}
            style={
              ratio
                ? { transform: `translate(${vp.x}px, ${vp.y}px)` }
                : view === 'split'
                  ? { clipPath: `inset(0 0 0 ${split * 100}%)`, transform }
                  : { transform }
            }
          >
            {ratio ? (
              <div className={styles.canvas} style={canvasStyle}>
                <img src={svgUrl} alt="Vector result" className={styles.fill} draggable={false} />
                {picker && (
                  <>
                    {/* Invisible copy of the artwork, only for hit testing clicks. Our own
                        renderer's output: every string from the file is escaped. */}
                    <div
                      ref={hitRef}
                      className={styles.hit}
                      aria-hidden
                      dangerouslySetInnerHTML={{ __html: picker.hitSvg }}
                    />
                    <div className={styles.marks} aria-hidden>
                      {selBoxes.map((b, i) => (
                        <div key={i} className={styles.mark} style={pct(b)} />
                      ))}
                      {hover && <div className={`${styles.mark} ${styles.hoverMark}`} style={pct(hover)} />}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <img src={svgUrl} alt="Vector result" className={styles.media} draggable={false} />
            )}
          </div>
        )}

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
