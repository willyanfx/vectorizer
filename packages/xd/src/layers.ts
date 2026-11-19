import type { XdLayer } from './types'

/** Depth-first visit of a layer tree. */
export function walkLayers(layers: XdLayer[], fn: (l: XdLayer) => void) {
  for (const l of layers) {
    fn(l)
    walkLayers(l.children, fn)
  }
}

/** Layer key → parent layer key (null at the top level). */
export function layerParents(layers: XdLayer[]): Map<string, string | null> {
  const map = new Map<string, string | null>()
  const walk = (list: XdLayer[], parent: string | null) => {
    for (const l of list) {
      map.set(l.key, parent)
      walk(l.children, l.key)
    }
  }
  walk(layers, null)
  return map
}

function isAncestor(parents: Map<string, string | null>, a: string, b: string): boolean {
  for (let p = parents.get(b); p; p = parents.get(p)) if (p === a) return true
  return false
}

/**
 * Which layer a click on the canvas selects, given the layers under the
 * pointer (outermost first). Like Figma: a click picks the top-level layer,
 * or a sibling of the current selection once you have gone into a group;
 * `drill` (double-click) goes one level deeper; `deep` (⌘-click) picks the
 * innermost layer.
 */
export function pickLayer(
  chain: string[],
  selected: ReadonlySet<string>,
  parents: Map<string, string | null>,
  how: { deep?: boolean; drill?: boolean } = {},
): string | null {
  if (!chain.length) return null
  if (how.deep) return chain[chain.length - 1]
  let depth = 0
  for (const s of selected) {
    const i = chain.indexOf(s)
    if (i >= 0) {
      depth = Math.max(depth, how.drill ? i + 1 : i)
      continue
    }
    const p = parents.get(s)
    const j = p ? chain.indexOf(p) : -1
    if (j >= 0) depth = Math.max(depth, j + 1)
  }
  return chain[Math.min(depth, chain.length - 1)]
}

/** Shift-click: toggle a layer, dropping any of its ancestors or descendants. */
export function toggleLayer(
  selected: ReadonlySet<string>,
  key: string,
  parents: Map<string, string | null>,
): Set<string> {
  if (selected.has(key)) return new Set([...selected].filter((s) => s !== key))
  const next = new Set([...selected].filter((s) => !isAncestor(parents, s, key) && !isAncestor(parents, key, s)))
  next.add(key)
  return next
}
