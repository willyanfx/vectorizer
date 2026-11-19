// Public data types of @vector/xd.

/** One entry in an artboard's layer tree (like the Layers panel in XD/Figma). */
export interface XdLayer {
  /** Id of the element in the artboard SVG (`<g id={key}>`). */
  key: string
  name: string
  kind: 'group' | 'shape' | 'image' | 'text' | 'component' | 'mask'
  children: XdLayer[]
  /** Text layers: the text as displayed (XD's case styles applied). */
  text?: string
}

export interface XdArtboard {
  id: string
  name: string
  width: number
  height: number
  /** Export SVG: fixed width/height so design tools keep the intended size. */
  svg: string
  /** Number of nodes the renderer did not understand and skipped. */
  skipped: number
  /** SVG with image placeholders, re-filled when the image scale changes. */
  template: string
  /** Top-level layers, top-most last (SVG paint order). */
  layers: XdLayer[]
}

export interface XdDocument {
  name: string
  artboards: XdArtboard[]
  /** Embedded raster preview, if the file has one (object URL). */
  previewUrl: string | null
  /** Current image scale (see ParseXdOptions.imageScale). */
  imageScale: number
  /** Image placeholder key → data URI at the current scale. */
  imageUris: Map<string, string>
  /** Original file + image sizes, so images can be re-processed at another scale. */
  source: { file: File; imageNeeds: Map<string, { w: number; h: number }> }
}

export interface ParseXdOptions {
  /**
   * Embedded images are downscaled to this multiple of their on-artboard size
   * (2 = retina-sharp). 0 keeps the original files untouched. XD files often
   * carry 20–30 MB source PNGs that would otherwise bloat the SVG and PDF.
   */
  imageScale?: number
  onProgress?: (message: string) => void
}

export interface ComposeOptions {
  /** Layer keys to leave out. */
  hidden?: ReadonlySet<string>
  /** Export only these layers, cropped to their bounds (artboard background dropped). */
  only?: ReadonlySet<string>
}

export interface ComposedSvg {
  svg: string
  width: number
  height: number
}

export type Rect = { left: number; top: number; right: number; bottom: number }
