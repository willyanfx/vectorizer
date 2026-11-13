import { useEffect, useMemo, useRef, useState } from 'react'
import { layerParents, walkLayers, type XdLayer } from '../lib/xd'
import styles from './XdLayerTree.module.css'

interface Props {
  layers: XdLayer[]
  selected: Set<string>
  onSelected: (s: Set<string>) => void
  hidden: Set<string>
  onHidden: (s: Set<string>) => void
}

/** Layers panel for one artboard: expand groups, pick layers to export, hide layers. */
export function XdLayerTree({ layers, selected, onSelected, hidden, onHidden }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const treeRef = useRef<HTMLUListElement>(null)

  const { descendants, parents, all } = useMemo(() => {
    const descendants = new Map<string, string[]>()
    const parents = layerParents(layers)
    const all: XdLayer[] = []
    walkLayers(layers, (l) => {
      all.push(l)
      const keys: string[] = []
      walkLayers(l.children, (c) => keys.push(c.key))
      descendants.set(l.key, keys)
    })
    return { descendants, parents, all }
  }, [layers])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? all.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 200) : null
  }, [all, query])

  // Layers picked on the canvas may sit deep inside collapsed groups: open
  // their ancestors (adjusting state while rendering, not in an effect).
  const [revealed, setRevealed] = useState(selected)
  if (revealed !== selected) {
    setRevealed(selected)
    const open: string[] = []
    for (const k of selected) for (let p = parents.get(k); p; p = parents.get(p)) if (!expanded.has(p)) open.push(p)
    if (open.length) setExpanded(new Set([...expanded, ...open]))
  }
  // …and bring the selection into view.
  useEffect(() => {
    const first = [...selected][0]
    if (!first) return
    treeRef.current?.querySelector(`[data-key="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const toggleExpanded = (k: string) => {
    const next = new Set(expanded)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setExpanded(next)
  }

  // Selecting a group covers its children, so drop any of them from the set.
  const select = (l: XdLayer, additive: boolean) => {
    const next = new Set(additive ? selected : [])
    if (additive && selected.has(l.key)) next.delete(l.key)
    else {
      for (const d of descendants.get(l.key) ?? []) next.delete(d)
      next.add(l.key)
    }
    onSelected(next)
  }

  const toggleHidden = (l: XdLayer) => {
    const next = new Set(hidden)
    if (next.has(l.key)) next.delete(l.key)
    else next.add(l.key)
    onHidden(next)
  }

  const row = (l: XdLayer, depth: number, inSel: boolean, inHidden: boolean, flat = false) => {
    const isSel = selected.has(l.key)
    const isHidden = hidden.has(l.key)
    const open = !flat && expanded.has(l.key)
    const hasKids = !flat && l.children.length > 0
    return (
      <li key={l.key} role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={isSel}>
        <div
          data-key={l.key}
          className={`${styles.row} ${isSel ? styles.selected : ''} ${inSel ? styles.inSelection : ''} ${isHidden || inHidden ? styles.hidden : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {hasKids ? (
            <button
              className={styles.chevron}
              onClick={() => toggleExpanded(l.key)}
              aria-label={open ? `Collapse ${l.name}` : `Expand ${l.name}`}
            >
              <svg viewBox="0 0 10 10" width="10" height="10" className={open ? styles.open : ''}>
                <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <span className={styles.chevronSpacer} />
          )}
          <input
            type="checkbox"
            checked={isSel || inSel}
            disabled={inSel}
            onChange={() => select(l, true)}
            aria-label={`Select ${l.name} for export`}
          />
          <KindIcon kind={l.kind} />
          <button
            className={styles.name}
            title={`${l.name} — click to select, ⌘/Shift-click to add`}
            onClick={(e) => select(l, e.metaKey || e.ctrlKey || e.shiftKey)}
          >
            {l.name}
          </button>
          <button
            className={styles.eye}
            disabled={inHidden}
            onClick={() => toggleHidden(l)}
            aria-label={isHidden ? `Show ${l.name}` : `Hide ${l.name}`}
            aria-pressed={isHidden}
          >
            {isHidden ? <EyeOff /> : <Eye />}
          </button>
        </div>
        {open && (
          <ul role="group" className={styles.list}>
            {[...l.children].reverse().map((c) => row(c, depth + 1, inSel || isSel, inHidden || isHidden))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className={styles.wrap}>
      <input
        className={styles.filter}
        type="search"
        placeholder="Filter layers…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Filter layers"
      />
      <ul ref={treeRef} className={`${styles.list} ${styles.tree}`} role="tree" aria-label="Layers" aria-multiselectable>
        {matches
          ? matches.map((l) => row(l, 0, false, false, true))
          : [...layers].reverse().map((l) => row(l, 0, false, false))}
        {matches?.length === 0 && <li className={styles.empty}>No layers match “{query}”.</li>}
      </ul>
    </div>
  )
}

function KindIcon({ kind }: { kind: XdLayer['kind'] }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }
  return (
    <svg className={styles.kind} viewBox="0 0 14 14" width="14" height="14" aria-label={kind} role="img">
      {kind === 'text' && <path d="M3 3.5h8M7 3.5v8" {...p} strokeLinecap="round" />}
      {kind === 'shape' && <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" {...p} />}
      {kind === 'image' && (
        <>
          <rect x="2" y="2.5" width="10" height="9" rx="1.5" {...p} />
          <path d="M2.5 10l3-3 2.5 2.5 1.5-1.5 2 2" {...p} strokeLinejoin="round" />
        </>
      )}
      {kind === 'group' && <path d="M1.8 4.2v6.6h10.4V5.4H7L5.8 3.2H1.8z" {...p} strokeLinejoin="round" />}
      {kind === 'mask' && (
        <>
          <rect x="2" y="2" width="10" height="10" rx="1.5" {...p} />
          <circle cx="7" cy="7" r="2.8" {...p} />
        </>
      )}
      {kind === 'component' && <path d="M7 1.8L12.2 7 7 12.2 1.8 7z" {...p} strokeLinejoin="round" />}
    </svg>
  )
}

const Eye = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  </svg>
)

const EyeOff = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M2 2l12 12M6.3 4A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.3M10.4 11.9A6.3 6.3 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.4-2.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)
