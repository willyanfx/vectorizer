import {
  DEFAULT_PARAMS,
  PRESETS,
  type CurveMode,
  type ColorMode,
  type Hierarchical,
  type TraceParams,
} from '../lib/params'
import type { PreprocessOptions } from '../gpu'
import styles from './ParamsPanel.module.css'

interface Props {
  params: TraceParams
  onParams: (p: TraceParams) => void
  preprocess: PreprocessOptions
  onPreprocess: (p: PreprocessOptions) => void
  backend: 'webgpu' | 'canvas' | null
  disabled?: boolean
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>
        {label}
        <output className={styles.value}>{value}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function ParamsPanel({
  params,
  onParams,
  preprocess,
  onPreprocess,
  backend,
  disabled,
}: Props) {
  const set = <K extends keyof TraceParams>(key: K, value: TraceParams[K]) =>
    onParams({ ...params, [key]: value })
  const setPre = <K extends keyof PreprocessOptions>(key: K, value: PreprocessOptions[K]) =>
    onPreprocess({ ...preprocess, [key]: value })

  const binary = params.colorMode === 'binary'

  return (
    <div className={styles.panel} aria-disabled={disabled}>
      <section className={styles.section}>
        <h3 className={styles.heading}>Presets</h3>
        <div className={styles.presets}>
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={styles.preset}
              title={preset.description}
              disabled={disabled}
              onClick={() => onParams({ ...params, ...preset.params })}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Tracer</h3>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Color mode</span>
          <select
            value={params.colorMode}
            disabled={disabled}
            onChange={(e) => set('colorMode', e.target.value as ColorMode)}
          >
            <option value="color">Color</option>
            <option value="binary">Black &amp; white</option>
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Curve mode</span>
          <select
            value={params.mode}
            disabled={disabled}
            onChange={(e) => set('mode', e.target.value as CurveMode)}
          >
            <option value="spline">Spline (smooth)</option>
            <option value="polygon">Polygon (sharp)</option>
            <option value="pixel">Pixel (no curves)</option>
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Layering</span>
          <select
            value={params.hierarchical}
            disabled={disabled}
            onChange={(e) => set('hierarchical', e.target.value as Hierarchical)}
          >
            <option value="stacked">Stacked</option>
            <option value="cutout">Cutout</option>
          </select>
        </label>

        <Slider
          label="Filter speckle"
          value={params.filterSpeckle}
          min={0}
          max={128}
          onChange={(v) => set('filterSpeckle', v)}
          disabled={disabled}
        />
        {!binary && (
          <>
            <Slider
              label="Color precision"
              value={params.colorPrecision}
              min={1}
              max={8}
              onChange={(v) => set('colorPrecision', v)}
              disabled={disabled}
            />
            <Slider
              label="Layer difference"
              value={params.layerDifference}
              min={0}
              max={128}
              onChange={(v) => set('layerDifference', v)}
              disabled={disabled}
            />
          </>
        )}
        {params.mode !== 'pixel' && (
          <>
            <Slider
              label="Corner threshold"
              value={params.cornerThreshold}
              min={0}
              max={180}
              onChange={(v) => set('cornerThreshold', v)}
              disabled={disabled}
            />
            <Slider
              label="Segment length"
              value={params.lengthThreshold}
              min={3.5}
              max={10}
              step={0.5}
              onChange={(v) => set('lengthThreshold', v)}
              disabled={disabled}
            />
            <Slider
              label="Splice threshold"
              value={params.spliceThreshold}
              min={0}
              max={180}
              onChange={(v) => set('spliceThreshold', v)}
              disabled={disabled}
            />
            <Slider
              label="Curve iterations"
              value={params.maxIterations}
              min={1}
              max={70}
              onChange={(v) => set('maxIterations', v)}
              disabled={disabled}
            />
          </>
        )}
        <Slider
          label="Path precision"
          value={params.pathPrecision}
          min={0}
          max={8}
          onChange={(v) => set('pathPrecision', v)}
          disabled={disabled}
        />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>
          Preprocessing
          {backend && <span className={styles.badge}>{backend === 'webgpu' ? 'GPU' : 'CPU'}</span>}
        </h3>
        <Slider
          label="Max size (px)"
          value={preprocess.maxSize}
          min={256}
          max={4096}
          step={128}
          onChange={(v) => setPre('maxSize', v)}
          disabled={disabled}
        />
        <Slider
          label="Blur radius"
          value={preprocess.blur}
          min={0}
          max={10}
          step={0.5}
          onChange={(v) => setPre('blur', v)}
          disabled={disabled}
        />
        <Slider
          label="Quantize colors (0 = off)"
          value={preprocess.quantizeColors}
          min={0}
          max={64}
          step={2}
          onChange={(v) => setPre('quantizeColors', v)}
          disabled={disabled}
        />
      </section>

      <button
        type="button"
        className={styles.reset}
        disabled={disabled}
        onClick={() => onParams(DEFAULT_PARAMS)}
      >
        Reset parameters
      </button>
    </div>
  )
}
