import { useState } from 'react'
import type { XdDocument } from '../lib/xd'
import { downloadPdf, downloadSvg, downloadSvgZip, safeFileName } from '../lib/exportFiles'
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
}

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
}: Props) {
  const [busy, setBusy] = useState<null | 'pdf' | 'zip'>(null)
  const [error, setError] = useState<string | null>(null)
  const boards = doc.artboards
  const picked = boards.filter((_, i) => selected.has(i))
  const skipped = boards.reduce((s, a) => s + a.skipped, 0)

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
        await downloadPdf(picked.map((a) => a.svg), `${safeFileName(name)}.pdf`)
      } else {
        await downloadSvgZip(picked.map((a) => ({ name: a.name, svg: a.svg })), `${safeFileName(doc.name)}.zip`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const exportSelectedSvg = () => {
    if (picked.length === 1) downloadSvg(picked[0].svg, `${safeFileName(picked[0].name)}.svg`)
    else void run('zip')
  }

  return (
    <section className={styles.panel} aria-labelledby="xd-heading">
      <h2 id="xd-heading" className={styles.heading}>
        Adobe XD · {boards.length} artboard{boards.length === 1 ? '' : 's'}
      </h2>

      {boards.length > 0 && (
        <>
          <div className={styles.listHeader}>
            <span>Export</span>
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
