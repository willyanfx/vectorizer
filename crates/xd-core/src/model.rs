//! Public data types. Mirrors packages/xd/src/types.ts (field names are
//! camelCase when serialized, so they match the TypeScript objects).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayerKind {
    Group,
    Shape,
    Image,
    Text,
    Component,
    Mask,
}

impl LayerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LayerKind::Group => "group",
            LayerKind::Shape => "shape",
            LayerKind::Image => "image",
            LayerKind::Text => "text",
            LayerKind::Component => "component",
            LayerKind::Mask => "mask",
        }
    }
}

/// One entry in an artboard's layer tree (like the Layers panel in XD/Figma).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct XdLayer {
    /// Id of the element in the artboard SVG (`<g id={key}>`).
    pub key: String,
    pub name: String,
    pub kind: LayerKind,
    pub children: Vec<XdLayer>,
    /// Text layers: the text as displayed (XD's case styles applied).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XdArtboard {
    pub id: String,
    pub name: String,
    pub width: f64,
    pub height: f64,
    /// Export SVG: fixed width/height so design tools keep the intended size.
    pub svg: String,
    /// Number of nodes the renderer did not understand and skipped.
    pub skipped: u32,
    /// SVG with image placeholders, re-filled when the image scale changes.
    pub template: String,
    /// Top-level layers, top-most last (SVG paint order).
    pub layers: Vec<XdLayer>,
}

/// Artboard summary without rendering (see `XdArchive::artboards`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtboardInfo {
    pub id: String,
    pub name: String,
    /// Archive path of the artboard's scene graph (`graphicContent.agc`).
    pub path: String,
    pub width: f64,
    pub height: f64,
    /// Position on the pasteboard.
    pub x: f64,
    pub y: f64,
}

/// Embedded raster preview.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Preview {
    pub mime: &'static str,
    #[serde(with = "serde_bytes")]
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XdDocument {
    pub artboards: Vec<XdArtboard>,
    /// Current image scale (see `ParseOptions::image_scale`).
    pub image_scale: f64,
    /// Image placeholder key → data URI at the current scale.
    pub image_uris: IndexMap<String, String>,
    /// Largest displayed size per image, to re-process at another scale.
    pub image_needs: IndexMap<String, Size>,
    pub preview: Option<Preview>,
}
