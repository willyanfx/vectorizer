import type { OptimizeOptions } from '../lib/optimize'
import styles from './OptimizePanel.module.css'

interface Props {
  options: OptimizeOptions
  onOptions: (o: OptimizeOptions) => void
  rawSize: number
  optimizedSize: number
  savedPct: number
  optimizing: boolean
  disabled?: boolean
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export function OptimizePanel({
  options,
  onOptions,
  rawSize,
  optimizedSize,
  savedPct,
  optimizing,
  disabled,
}: Props) {
  const set = <K extends keyof OptimizeOptions>(key: K, value: OptimizeOptions[K]) =>
    onOptions({ ...options, [key]: value })

  const childrenDisabled = disabled || !options.enabled

  return (
    <section className={styles.panel} aria-disabled={disabled}>
      <h3 className={styles.heading}>
        Optimize export
        {optimizing && <span className={styles.spinner} aria-label="Optimizing" />}
      </h3>

      <Toggle
        label="Optimize SVG (SVGO)"
        checked={options.enabled}
        onChange={(v) => set('enabled', v)}
        disabled={disabled}
      />

      {/* live size readout */}
      {rawSize > 0 && (
        <div className={styles.sizes}>
          <span className={styles.sizeRaw}>{bytes(rawSize)}</span>
          {options.enabled && (
            <>
              <span className={styles.arrow}>→</span>
              <span className={styles.sizeOpt}>{bytes(optimizedSize)}</span>
              <span className={savedPct > 0 ? styles.saved : styles.savedNone}>
                {savedPct > 0 ? `−${savedPct.toFixed(0)}%` : '0%'}
              </span>
            </>
          )}
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Precision
          <output className={styles.value}>{options.precision}</output>
        </span>
        <input
          type="range"
          min={0}
          max={8}
          step={1}
          value={options.precision}
          disabled={childrenDisabled}
          onChange={(e) => set('precision', Number(e.target.value))}
        />
      </label>

      <div className={styles.toggles}>
        <Toggle
          label="Multipass"
          checked={options.multipass}
          onChange={(v) => set('multipass', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Convert path data"
          checked={options.convertPathData}
          onChange={(v) => set('convertPathData', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Merge paths"
          checked={options.mergePaths}
          onChange={(v) => set('mergePaths', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Collapse groups"
          checked={options.collapseGroups}
          onChange={(v) => set('collapseGroups', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Clean up IDs"
          checked={options.cleanupIds}
          onChange={(v) => set('cleanupIds', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Remove comments"
          checked={options.removeComments}
          onChange={(v) => set('removeComments', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Remove metadata"
          checked={options.removeMetadata}
          onChange={(v) => set('removeMetadata', v)}
          disabled={childrenDisabled}
        />
        <Toggle
          label="Remove viewBox (risky)"
          checked={options.removeViewBox}
          onChange={(v) => set('removeViewBox', v)}
          disabled={childrenDisabled}
        />
      </div>
    </section>
  )
}
