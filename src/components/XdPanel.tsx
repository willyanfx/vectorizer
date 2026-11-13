import { useMemo, useState } from 'react'
import { composeArtboard, walkLayers, type XdArtboard, type XdDocument } from '../lib/xd'
import { downloadPdf, downloadSvg, downloadSvgZip, safeFileName } from '../lib/exportFiles'
import { XdLayerTree } from './XdLayerTree'
import styles from './XdPanel.module.css'

interface Props {
  doc: XdDocument
  current: number
  onCurrent: (i: number) => void
  selected: Set<number>
  onSelected: (s: Set<number>) => void
  /** Hand the embedded raster preview to the tracer instead. */
  onTracePreview?: () => void
  onImageScale: (scale: number) => void
  /** Progress message while images are re-processed, else null. */
  imageBusy: string | null
  /** Layers picked for export on the current artboard. */
  layerSel: Set<string>
  onLayerSel: (s: Set<string>) => void
  /** Hidden layer keys per artboard id. */
  hidden: Map<string, Set<string>>
  onHidden: (m: Map<string, Set<string>>) => void
  /** Preview only the selected layers. */
  isolate: boolean
  onIsolate: (v: boolean) => void
}

const NONE = new Set<string>()

const IMAGE_SCALES: Array<{ value: number; label: string; hint: string }> = [
  { value: 1, label: '1×', hint: 'Smallest files. Images match their on-screen size.' },
  { value: 2, label: '2×', hint: 'Sharp on retina screens. Good default for sharing.' },
  { value: 0, label: 'Original', hint: 'Full-resolution source images, for print. Files can be very large.' },
]

export function XdPanel({
  doc,
  current,
  onCurrent,
  selected,
  onSelected,
  onTracePreview,
  onImageScale,
  imageBusy,
  layerSel,
  onLayerSel,
  hidden,
  onHidden,
  isolate,
  onIsolate,
}: Props) {
  const [busy, setBusy] = useState<null | 'pdf' | 'zip' | 'layers-pdf' | 'layers-svg'>(null)
  const [error, setError] = useState<string | null>(null)
  const [perLayer, setPerLayer] = useState(false)
  const boards = doc.artboards
  const picked = boards.filter((_, i) => selected.has(i))
  const skipped = boards.reduce((s, a) => s + a.skipped, 0)
  const board = boards[current] as XdArtboard | undefined
  const boardHidden = (board && hidden.get(board.id)) ?? NONE

  const names = useMemo(() => {
    const m = new Map<string, string>()
    if (board) walkLayers(board.layers, (l) => m.set(l.key, l.name))
    return m
  }, [board])

  /** Artboard SVG with that artboard's hidden layers removed. */
  const boardSvg = (a: XdArtboard) => composeArtboard(doc, a, { hidden: hidden.get(a.id) }).svg

  const toggle = (i: number) => {
    const next = new Set(selected)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    onSelected(next)
  }

  const run = async (kind: 'pdf' | 'zip') => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'pdf') {
        const name = picked.length === 1 ? `${doc.name} - ${picked[0].name}` : doc.name
        await downloadPdf(picked.map(boardSvg), `${safeFileName(name)}.pdf`)
      } else {
        await downloadSvgZip(picked.map((a) => ({ name: a.name, svg: boardSvg(a) })), `${safeFileName(doc.name)}.zip`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const exportSelectedSvg = () => {
    if (picked.length === 1) downloadSvg(boardSvg(picked[0]), `${safeFileName(picked[0].name)}.svg`)
    else void run('zip')
  }

  const exportLayers = async (kind: 'pdf' | 'svg') => {
    if (!board || !layerSel.size) return
    setBusy(kind === 'pdf' ? 'layers-pdf' : 'layers-svg')
    setError(null)
    try {
      const keys = [...layerSel]
      const separate = perLayer && keys.length > 1
      const items = (separate ? keys.map((k) => new Set([k])) : [layerSel])
        .map((only) => ({
          name: only.size === 1 ? (names.get([...only][0]) ?? 'Layer') : `${board.name} - selection`,
          svg: composeArtboard(doc, board, { hidden: boardHidden, only }).svg,
        }))
        .filter((i) => i.svg)
      if (!items.length) throw new Error('The selected layers are hidden or empty.')
      const base = items.length === 1 ? items[0].name : `${board.name} - layers`
      if (kind === 'pdf') await downloadPdf(items.map((i) => i.svg), `${safeFileName(base)}.pdf`)
      else if (items.length === 1) downloadSvg(items[0].svg, `${safeFileName(base)}.svg`)
      else await downloadSvgZip(items, `${safeFileName(base)}.zip`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="xd-heading">
      <h2 id="xd-heading" className={styles.heading}>
        Adobe XD · {boards.length} artboard{boards.length === 1 ? '' : 's'}
      </h2>

      {boards.length > 0 && (
        <>
          <div className={styles.listHeader}>
            <span>Artboards</span>
            <button
              className={styles.link}
              onClick={() =>
                onSelected(selected.size === boards.length ? new Set() : new Set(boards.map((_, i) => i)))
              }
            >
              {selected.size === boards.length ? 'None' : 'All'}
            </button>
          </div>
          <ul className={styles.list}>
            {boards.map((a, i) => (
              <li key={a.id} className={`${styles.item} ${i === current ? styles.active : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(i)}
                  onChange={() => toggle(i)}
                  aria-label={`Include ${a.name} in export`}
                />
                <button className={styles.name} onClick={() => onCurrent(i)} aria-current={i === current}>
                  <span className={styles.label}>{a.name}</span>
                  <span className={styles.dims}>
                    {Math.round(a.width)}×{Math.round(a.height)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {board && board.layers.length > 0 && (
            <div className={styles.field}>
              <div className={styles.listHeader}>
                <span className={styles.fieldLabel}>Layers</span>
                {(layerSel.size > 0 || boardHidden.size > 0) && (
                  <button
                    className={styles.link}
                    onClick={() => {
                      onLayerSel(new Set())
                      const next = new Map(hidden)
                      next.delete(board.id)
                      onHidden(next)
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
              <XdLayerTree
                key={board.id}
                layers={board.layers}
                selected={layerSel}
                onSelected={onLayerSel}
                hidden={boardHidden}
                onHidden={(s) => onHidden(new Map(hidden).set(board.id, s))}
              />
              {layerSel.size > 0 ? (
                <div className={styles.selection}>
                  <p className={styles.note}>
                    {layerSel.size} layer{layerSel.size === 1 ? '' : 's'} selected · Esc to clear.
                  </p>
                  <label className={styles.check}>
                    <input type="checkbox" checked={isolate} onChange={(e) => onIsolate(e.target.checked)} />
                    Preview only the selection, as exported
                  </label>
                  {layerSel.size > 1 && (
                    <label className={styles.check}>
                      <input type="checkbox" checked={perLayer} onChange={(e) => setPerLayer(e.target.checked)} />
                      One file per layer
                    </label>
                  )}
                  <div className={styles.actions}>
                    <button
                      className={styles.button}
                      disabled={!!busy || !!imageBusy}
                      onClick={() => void exportLayers('pdf')}
                    >
                      {busy === 'layers-pdf' ? 'Building PDF…' : 'Selection PDF'}
                    </button>
                    <button
                      className={`${styles.button} ${styles.secondary}`}
                      disabled={!!busy || !!imageBusy}
                      onClick={() => void exportLayers('svg')}
                    >
                      {busy === 'layers-svg' ? 'Exporting…' : perLayer && layerSel.size > 1 ? 'SVGs (.zip)' : 'Selection SVG'}
                    </button>
                  </div>
                </div>
              ) : (
                <p className={styles.note}>
                  Click items on the canvas (or tick layers) to export just those. Shift-click adds, double-click
                  goes into a group, ⌘-click picks the innermost layer. The eye leaves a layer out of every export.
                </p>
              )}
            </div>
          )}

          <div className={styles.field}>
            <span className={styles.fieldLabel} id="xd-img-scale">
              Images
            </span>
            <div className={styles.segmented} role="radiogroup" aria-labelledby="xd-img-scale">
              {IMAGE_SCALES.map((o) => (
                <button
                  key={o.value}
                  role="radio"
                  aria-checked={doc.imageScale === o.value}
                  className={`${styles.segment} ${doc.imageScale === o.value ? styles.segmentOn : ''}`}
                  disabled={!!imageBusy || !!busy}
                  onClick={() => doc.imageScale !== o.value && onImageScale(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className={styles.note} role="status">
              {imageBusy ?? IMAGE_SCALES.find((o) => o.value === doc.imageScale)?.hint}
            </p>
          </div>

          <span className={styles.fieldLabel}>Export artboards</span>
          <div className={styles.actions}>
            <button className={styles.button} disabled={!picked.length || !!busy || !!imageBusy} onClick={() => void run('pdf')}>
              {busy === 'pdf' ? 'Building PDF…' : picked.length > 1 ? `PDF (${picked.length} pages)` : 'Download PDF'}
            </button>
            <button
              className={`${styles.button} ${styles.secondary}`}
              disabled={!picked.length || !!busy || !!imageBusy}
              onClick={exportSelectedSvg}
            >
              {busy === 'zip' ? 'Zipping…' : picked.length > 1 ? `SVGs (.zip, ${picked.length})` : 'Download SVG'}
            </button>
          </div>
        </>
      )}

      {error && <p className={styles.error}>⚠ {error}</p>}

      {skipped > 0 && (
        <p className={styles.note}>
          {skipped} element{skipped === 1 ? '' : 's'} used features this converter doesn’t support yet and
          were left out.
        </p>
      )}
      <p className={styles.note}>
        PDFs use built-in fonts; custom typefaces fall back to Helvetica. Export SVG to keep font names.
      </p>

      {onTracePreview && (
        <button className={`${styles.button} ${styles.secondary}`} onClick={onTracePreview}>
          Trace embedded preview instead
        </button>
      )}
    </section>
  )
}
