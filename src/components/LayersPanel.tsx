import { useState } from 'react'
import type { LayerMode, NamedLayout } from '../lib/layers'
import styles from './LayersPanel.module.css'

export type AiStatus = 'idle' | 'preparing' | 'asking' | 'error'

interface Props {
  mode: LayerMode
  onMode: (m: LayerMode) => void
  aiStatus: AiStatus
  aiError: string | null
  /** AI layout for the current trace (null if none, or if it went stale). */
  aiLayout: NamedLayout | null
  /** An AI layout exists but belongs to an earlier trace. */
  aiStale: boolean
  onRunAi: (apiKey: string) => void
  onClearAi: () => void
  disabled?: boolean
}

const KEY_STORAGE = 'vector.anthropicApiKey'

function readStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

function storeKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    // storage blocked (private mode etc.): the key just isn't remembered
  }
}

export function LayersPanel({
  mode,
  onMode,
  aiStatus,
  aiError,
  aiLayout,
  aiStale,
  onRunAi,
  onClearAi,
  disabled,
}: Props) {
  const [apiKey, setApiKey] = useState(readStoredKey)
  const [remember, setRemember] = useState(() => readStoredKey() !== '')
  const busy = aiStatus === 'preparing' || aiStatus === 'asking'

  const run = () => {
    storeKey(remember ? apiKey : null)
    onRunAi(apiKey.trim())
  }

  return (
    <section className={styles.panel} aria-disabled={disabled}>
      <h3 className={styles.heading}>Export layers</h3>

      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={mode === 'color'}
          disabled={disabled || !!aiLayout}
          onChange={(e) => onMode(e.target.checked ? 'color' : 'flat')}
        />
        <span>Group paths into layers by color</span>
      </label>

      <details className={styles.ai}>
        <summary>AI layer names (optional)</summary>
        <p className={styles.note}>
          Groups shapes into named layers like <code>logo-icon</code> or <code>text-heading</code>.
          This is the only feature that leaves your device: a downscaled copy of the image is sent to
          Anthropic&rsquo;s API using <strong>your own</strong> API key.
        </p>

        {aiLayout ? (
          <>
            <ul className={styles.names}>
              {aiLayout.background.length > 0 && <li>background</li>}
              {aiLayout.groups.map((g, i) => (
                <li key={i}>{g.name}</li>
              ))}
            </ul>
            <button className={styles.secondary} onClick={onClearAi} disabled={disabled}>
              Remove AI names
            </button>
          </>
        ) : (
          <>
            <input
              className={styles.key}
              type="password"
              placeholder="Anthropic API key (sk-ant-…)"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              disabled={disabled || busy}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={remember}
                disabled={disabled || busy}
                onChange={(e) => {
                  setRemember(e.target.checked)
                  if (!e.target.checked) storeKey(null)
                }}
              />
              <span>Remember key in this browser</span>
            </label>
            <button className={styles.primary} onClick={run} disabled={disabled || busy || !apiKey.trim()}>
              {aiStatus === 'preparing'
                ? 'Finding shapes…'
                : aiStatus === 'asking'
                  ? 'Asking Claude…'
                  : aiStale
                    ? 'Re-run for new trace'
                    : 'Name layers with Claude'}
            </button>
            {aiStale && !busy && (
              <p className={styles.note}>Tracing settings changed, so the previous names no longer apply.</p>
            )}
          </>
        )}
        {aiStatus === 'error' && aiError && <p className={styles.error}>{aiError}</p>}
      </details>
    </section>
  )
}
