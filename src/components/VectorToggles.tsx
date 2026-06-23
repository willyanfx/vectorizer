import type { BackgroundMode, ColorLayer, RenderStyle } from '../lib/vectorView'
import styles from './VectorToggles.module.css'

interface Props {
  render: RenderStyle
  onRender: (r: RenderStyle) => void
  background: BackgroundMode
  onBackground: (b: BackgroundMode) => void
  customBg: string
  onCustomBg: (c: string) => void
  layers: ColorLayer[]
  hiddenColors: Set<string>
  onToggleColor: (color: string) => void
  onShowAll: () => void
  onHideAll: () => void
  disabled?: boolean
}

const RENDER_OPTIONS: Array<{ value: RenderStyle; label: string }> = [
  { value: 'fill', label: 'Fill' },
  { value: 'outline', label: 'Outline' },
  { value: 'nodes', label: 'Nodes' },
]

const BG_OPTIONS: Array<{ value: BackgroundMode; label: string }> = [
  { value: 'checker', label: 'Checker' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'custom', label: 'Custom' },
]

export function VectorToggles({
  render,
  onRender,
  background,
  onBackground,
  customBg,
  onCustomBg,
  layers,
  hiddenColors,
  onToggleColor,
  onShowAll,
  onHideAll,
  disabled,
}: Props) {
  return (
    <section className={styles.panel} aria-disabled={disabled}>
      <h3 className={styles.heading}>Vector view</h3>

      <div className={styles.group}>
        <span className={styles.label}>Render</span>
        <div className={styles.segmented}>
          {RENDER_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`${styles.seg} ${render === o.value ? styles.segActive : ''}`}
              onClick={() => onRender(o.value)}
              disabled={disabled}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>Background</span>
        <div className={styles.segmented}>
          {BG_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`${styles.seg} ${background === o.value ? styles.segActive : ''}`}
              onClick={() => onBackground(o.value)}
              disabled={disabled}
            >
              {o.label}
            </button>
          ))}
        </div>
        {background === 'custom' && (
          <input
            type="color"
            className={styles.colorInput}
            value={customBg}
            disabled={disabled}
            onChange={(e) => onCustomBg(e.target.value)}
          />
        )}
      </div>

      {layers.length > 0 && (
        <div className={styles.group}>
          <div className={styles.layersHead}>
            <span className={styles.label}>Layers ({layers.length})</span>
            <div className={styles.layerActions}>
              <button onClick={onShowAll} disabled={disabled}>
                All
              </button>
              <button onClick={onHideAll} disabled={disabled}>
                None
              </button>
            </div>
          </div>
          <div className={styles.layers}>
            {layers.map((layer) => {
              const visible = !hiddenColors.has(layer.color)
              return (
                <button
                  key={layer.color}
                  className={`${styles.layer} ${visible ? '' : styles.layerHidden}`}
                  onClick={() => onToggleColor(layer.color)}
                  disabled={disabled}
                  title={`${layer.color} · ${layer.count} path${layer.count > 1 ? 's' : ''}`}
                >
                  <span className={styles.swatch} style={{ background: layer.color }} />
                  <span className={styles.hex}>{layer.color}</span>
                  <span className={styles.count}>{layer.count}</span>
                  <span className={styles.eye}>{visible ? '👁' : '—'}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
