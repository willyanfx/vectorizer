// @vector/xd — Adobe XD (.xd) → SVG, in the browser.
//
// Parsing and rendering run anywhere with File/Blob/TextDecoder (browser,
// Node ≥ 20). composeArtboard*, visibleRect and the pasteboard-coordinate
// fallback need a live DOM.

export type {
  ComposedSvg,
  ComposeOptions,
  ParseXdOptions,
  Rect,
  XdArtboard,
  XdDocument,
  XdLayer,
} from './types'
export { isXdFile, parseXd, setXdImageScale, toDisplaySvg } from './parse'
export { composeArtboard, composeArtboardWithHit } from './compose'
export { visibleRect } from './dom'
export { layerParents, pickLayer, toggleLayer, walkLayers } from './layers'
