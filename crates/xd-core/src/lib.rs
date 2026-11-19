//! Read Adobe XD (.xd) archives and render their artboards to SVG.
//!
//! A local .xd file is a ZIP archive:
//!
//! ```text
//! manifest                                             JSON: artboard list (names, bounds)
//! artwork/artboard-<id>/graphics/graphicContent.agc    JSON scene graph per artboard
//! resources/graphics/graphicContent.agc                JSON: shared gradients, clip paths, artboard bounds
//! resources/<uid>                                      raw image bytes (pattern fills)
//! ```
//!
//! This is the Rust port of `@vector/xd` (packages/xd). Its output is
//! byte-identical to the TypeScript renderer running without a DOM; the golden
//! fixtures in `packages/xd/test/fixtures` are checked by both test suites.
//! Two browser-only parts stay in TypeScript: composing/cropping layers
//! (`composeArtboard`) and the DOM measurement that breaks ties when deciding
//! whether an artboard uses pasteboard coordinates.

mod images;
mod js;
mod model;
mod render;

use std::collections::HashSet;
use std::fmt;
use std::io::{Cursor, Read};

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

pub use images::{BLANK_IMAGE, fill_images};
pub use model::{ArtboardInfo, LayerKind, Preview, Size, XdArtboard, XdDocument, XdLayer};
use render::artboard::{artboard_info, index_symbols, list_artboards, render_artboard};

const SHARED: &str = "resources/graphics/graphicContent.agc";
const PASTEBOARD: &str = "artwork/pasteboard/graphics/graphicContent.agc";

#[derive(Debug)]
pub enum Error {
    /// Not a ZIP archive: usually a Creative Cloud document, not a local file.
    NotLocalArchive,
    NoArtboards,
    Zip(zip::result::ZipError),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotLocalArchive => f.write_str(
                "This .xd file is not a local XD archive (it may be a cloud document). \
                 In Adobe XD use File → Save As… → \"On your computer\", then try again.",
            ),
            Error::NoArtboards => f.write_str("No artboards found in this XD file."),
            Error::Zip(e) => write!(f, "could not read the XD archive: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Error::Zip(e)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ParseOptions {
    /// Embedded images are downscaled to this multiple of their on-artboard
    /// size (2 = retina-sharp). 0 keeps the original files untouched.
    pub image_scale: f64,
}

impl Default for ParseOptions {
    fn default() -> Self {
        ParseOptions { image_scale: 2.0 }
    }
}

/// Parse an .xd file and render every artboard.
pub fn parse_xd(bytes: Vec<u8>, opts: ParseOptions) -> Result<XdDocument, Error> {
    XdArchive::open(bytes)?.parse(opts)
}

/// An opened .xd archive. Entries are read on demand, so large embedded
/// images are not decompressed unless asked for.
pub struct XdArchive {
    zip: zip::ZipArchive<Cursor<Vec<u8>>>,
    /// Entry names in archive order.
    names: Vec<String>,
    files: HashSet<String>,
}

impl XdArchive {
    pub fn open(bytes: Vec<u8>) -> Result<Self, Error> {
        if !bytes.starts_with(b"PK") {
            return Err(Error::NotLocalArchive);
        }
        let zip = zip::ZipArchive::new(Cursor::new(bytes))?;
        let names: Vec<String> = zip
            .file_names()
            .filter_map(Result::ok)
            .map(|n| n.into_owned())
            .collect();
        let files = names.iter().cloned().collect();
        Ok(Self { zip, names, files })
    }

    /// Names of all entries, in archive order.
    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn has(&self, name: &str) -> bool {
        self.files.contains(name)
    }

    /// Raw bytes of an entry, or None if it is missing or unreadable.
    pub fn read(&mut self, name: &str) -> Option<Vec<u8>> {
        let mut f = self.zip.by_name(name).ok()?;
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    /// An entry parsed as JSON; `Value::Null` if missing or invalid.
    pub fn json(&mut self, name: &str) -> Value {
        self.read(name).map_or(Value::Null, |b| parse_json(&b))
    }

    /// Artboards in manifest order with their sizes, without rendering.
    pub fn artboards(&mut self) -> Vec<ArtboardInfo> {
        let manifest = self.json("manifest");
        let shared = self.json(SHARED);
        list_artboards(&self.names, &self.files, &manifest)
            .iter()
            .map(|e| {
                let agc = self.json(&e.path);
                artboard_info(e, &agc, &shared)
            })
            .collect()
    }

    pub fn parse(&mut self, opts: ParseOptions) -> Result<XdDocument, Error> {
        let manifest = self.json("manifest");
        let shared = self.json(SHARED);
        let pasteboard = self.json(PASTEBOARD);
        let symbols = index_symbols(&[&shared["resources"]["meta"]["ux"]["symbols"], &pasteboard]);

        let entries = list_artboards(&self.names, &self.files, &manifest);
        let mut rendered = Vec::with_capacity(entries.len());
        for e in &entries {
            let agc = self.json(&e.path);
            rendered.push(render_artboard(&self.files, e, &agc, &shared, &symbols));
        }

        // Prepare each referenced image once, at the largest size any artboard needs.
        let mut needs: IndexMap<String, Size> = IndexMap::new();
        for a in &rendered {
            for (k, v) in &a.image_needs {
                let p = needs.get(k).copied().unwrap_or(Size { w: 0.0, h: 0.0 });
                needs.insert(
                    k.clone(),
                    Size {
                        w: js::max(p.w, v.w),
                        h: js::max(p.h, v.h),
                    },
                );
            }
        }
        let uris = self.process_images(&needs, opts.image_scale);

        let artboards: Vec<XdArtboard> = rendered
            .into_iter()
            .map(|a| XdArtboard {
                svg: fill_images(&a.svg, Some(&uris)),
                template: a.svg,
                id: a.id,
                name: a.name,
                width: a.width,
                height: a.height,
                skipped: a.skipped,
                layers: a.layers,
            })
            .collect();

        let preview = self.preview();
        if artboards.is_empty() && preview.is_none() {
            return Err(Error::NoArtboards);
        }
        Ok(XdDocument {
            artboards,
            image_scale: opts.image_scale,
            image_uris: uris,
            image_needs: needs,
            preview,
        })
    }

    /// Data URIs for the given images at `scale` (see `ParseOptions::image_scale`).
    /// Use this to change the image scale without re-rendering.
    pub fn process_images(
        &mut self,
        needs: &IndexMap<String, Size>,
        scale: f64,
    ) -> IndexMap<String, String> {
        let mut uris = IndexMap::new();
        for (key, size) in needs {
            let bytes = self.read(&format!("resources/{key}"));
            if let Some(uri) = images::image_data_uri(bytes.as_deref(), *size, scale) {
                uris.insert(key.clone(), uri);
            }
        }
        uris
    }

    /// The embedded raster preview, if the file has one.
    fn preview(&mut self) -> Option<Preview> {
        let key = self
            .names
            .iter()
            .find(|k| {
                let base = k.rsplit('/').next().unwrap_or(k).to_ascii_lowercase();
                matches!(
                    base.as_str(),
                    "preview.png"
                        | "preview.jpg"
                        | "preview.jpeg"
                        | "thumbnail.png"
                        | "thumbnail.jpg"
                        | "thumbnail.jpeg"
                )
            })?
            .clone();
        let bytes = self.read(&key)?;
        Some(Preview {
            mime: images::sniff_mime(&bytes).unwrap_or("image/png"),
            bytes,
        })
    }
}

/// Deepest JSON nesting we parse. serde_json's default (128) is too low for
/// XD scene graphs; unbounded would overflow the stack (1 MB in WebAssembly).
const MAX_JSON_DEPTH: usize = 512;

/// Nesting depth of a JSON text (brackets outside strings).
fn json_depth(text: &str) -> usize {
    let (mut depth, mut max, mut in_str, mut escaped) = (0usize, 0usize, false, false);
    for b in text.bytes() {
        if in_str {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_str = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'[' | b'{' => {
                depth += 1;
                max = max.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

/// `JSON.parse(new TextDecoder().decode(bytes))`: lossy UTF-8, BOM dropped.
/// Null when invalid or nested deeper than [`MAX_JSON_DEPTH`].
fn parse_json(bytes: &[u8]) -> Value {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if json_depth(text) > MAX_JSON_DEPTH {
        return Value::Null;
    }
    let mut de = serde_json::Deserializer::from_str(text);
    de.disable_recursion_limit();
    match Value::deserialize(&mut de).and_then(|v| de.end().map(|_| v)) {
        Ok(v) => v,
        Err(_) => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn xd(files: &[(&str, Value)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, v) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(v.to_string().as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn basic(with_manifest: bool) -> Vec<u8> {
        let mut files = vec![
            (
                SHARED,
                json!({ "artboards": { "artboard-A1": { "x": 0, "y": 0, "width": 375, "height": 812 } } }),
            ),
            (
                "artwork/artboard-A1/graphics/graphicContent.agc",
                json!({ "children": [{ "type": "artboard", "artboard": { "ref": "artboard-A1", "children": [] } }] }),
            ),
        ];
        if with_manifest {
            files.push((
                "manifest",
                json!({ "children": [{ "name": "artwork", "children": [{ "path": "artboard-A1", "name": "Home" }] }] }),
            ));
        }
        xd(&files)
    }

    #[test]
    fn lists_artboards_from_the_manifest() {
        let mut a = XdArchive::open(basic(true)).unwrap();
        assert_eq!(
            a.artboards(),
            vec![ArtboardInfo {
                id: "artboard-A1".into(),
                name: "Home".into(),
                path: "artwork/artboard-A1/graphics/graphicContent.agc".into(),
                width: 375.0,
                height: 812.0,
                x: 0.0,
                y: 0.0,
            }]
        );
    }

    #[test]
    fn falls_back_to_scanning_the_archive() {
        let boards = XdArchive::open(basic(false)).unwrap().artboards();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].name, "artboard-A1");
    }

    #[test]
    fn rejects_non_zip_files() {
        assert!(matches!(
            XdArchive::open(vec![1, 2, 3, 4]),
            Err(Error::NotLocalArchive)
        ));
    }

    #[test]
    fn errors_without_artboards() {
        let r = parse_xd(xd(&[("manifest", json!({}))]), ParseOptions::default());
        assert!(matches!(r, Err(Error::NoArtboards)));
    }

    #[test]
    fn parses_deeply_nested_json() {
        let nest = |n: usize| "[".repeat(n) + &"]".repeat(n);
        assert!(parse_json(nest(MAX_JSON_DEPTH).as_bytes()).is_array());
        assert!(
            parse_json(nest(100_000).as_bytes()).is_null(),
            "too deep: null, not a stack overflow"
        );
        assert_eq!(json_depth(r#"{"a":"[[\"]]","b":[{}]}"#), 3);
        assert!(parse_json(b"\xef\xbb\xbf{\"a\":1}").is_object());
        assert!(parse_json(b"{").is_null());
    }
}
