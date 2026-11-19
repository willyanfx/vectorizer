//! WebAssembly bindings for `xd-core`: the same document shape as
//! `parseXd` in @vector/xd (imageUris / imageNeeds are `Map`s).
//!
//! Build: `npm run build:xd-wasm` (output in `crates/xd-wasm/pkg`).

use indexmap::IndexMap;
use wasm_bindgen::prelude::*;
use xd_core::{ParseOptions, Size, XdArchive};

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn to_js<T: serde::Serialize>(v: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(v).map_err(js_err)
}

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type XdLayerKind = 'group' | 'shape' | 'image' | 'text' | 'component' | 'mask'
export interface XdLayer { key: string; name: string; kind: XdLayerKind; children: XdLayer[]; text?: string }
export interface XdArtboard {
  id: string; name: string; width: number; height: number
  svg: string; template: string; skipped: number; layers: XdLayer[]
}
export interface XdImageSize { w: number; h: number }
export interface XdWasmDocument {
  artboards: XdArtboard[]
  imageScale: number
  imageUris: Map<string, string>
  imageNeeds: Map<string, XdImageSize>
  preview: { mime: string; bytes: Uint8Array } | null
}
export interface XdArtboardInfo { id: string; name: string; path: string; width: number; height: number; x: number; y: number }
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "XdWasmDocument")]
    pub type XdWasmDocument;
    #[wasm_bindgen(typescript_type = "XdArtboardInfo[]")]
    pub type XdArtboardInfoList;
    #[wasm_bindgen(typescript_type = "Map<string, XdImageSize>")]
    pub type ImageNeeds;
    #[wasm_bindgen(typescript_type = "Map<string, string>")]
    pub type ImageUris;
}

/// Parse an .xd file and render every artboard to SVG.
/// `imageScale`: embedded images are downscaled to this multiple of their
/// on-artboard size (2 = retina-sharp); 0 keeps the original files.
#[wasm_bindgen(js_name = parseXd)]
pub fn parse_xd(bytes: Vec<u8>, image_scale: Option<f64>) -> Result<XdWasmDocument, JsError> {
    let opts = ParseOptions {
        image_scale: image_scale.unwrap_or(ParseOptions::default().image_scale),
    };
    let doc = xd_core::parse_xd(bytes, opts).map_err(js_err)?;
    Ok(to_js(&doc)?.unchecked_into())
}

/// Artboards with their sizes, without rendering (fast).
#[wasm_bindgen(js_name = listArtboards)]
pub fn list_artboards(bytes: Vec<u8>) -> Result<XdArtboardInfoList, JsError> {
    let mut xd = XdArchive::open(bytes).map_err(js_err)?;
    Ok(to_js(&xd.artboards())?.unchecked_into())
}

/// Re-process only the embedded images at a new scale (pass the document's
/// `imageNeeds`); fill each artboard's `template` with the result.
#[wasm_bindgen(js_name = processImages)]
pub fn process_images(
    bytes: Vec<u8>,
    image_needs: ImageNeeds,
    image_scale: f64,
) -> Result<ImageUris, JsError> {
    let needs: IndexMap<String, Size> =
        serde_wasm_bindgen::from_value(image_needs.into()).map_err(js_err)?;
    let mut xd = XdArchive::open(bytes).map_err(js_err)?;
    Ok(to_js(&xd.process_images(&needs, image_scale))?.unchecked_into())
}

/// Replace image placeholders in an artboard `template` with data URIs, or
/// with a transparent pixel when `uris` is omitted (hit-testing copies).
#[wasm_bindgen(js_name = fillImages)]
pub fn fill_images(template: &str, uris: Option<ImageUris>) -> Result<String, JsError> {
    let uris: Option<IndexMap<String, String>> = match uris {
        Some(u) => Some(serde_wasm_bindgen::from_value(u.into()).map_err(js_err)?),
        None => None,
    };
    Ok(xd_core::fill_images(template, uris.as_ref()))
}
