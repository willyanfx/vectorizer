//! Artboard discovery (manifest) and artboard → SVG.
//! Port of packages/xd/src/render/artboard.ts.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use super::context::{Ctx, Merged, color};
use super::nodes::render_node;
use crate::js::{self, NULL, esc, fmt, num, truthy};
use crate::model::{ArtboardInfo, Size, XdLayer};

const SVG_NS: &str = "http://www.w3.org/2000/svg";

pub struct ArtboardEntry {
    pub id: String,
    pub path: String,
    pub name: String,
    pub bounds: Value,
}

pub fn list_artboards<'n>(
    names: impl IntoIterator<Item = &'n String>,
    files: &HashSet<String>,
    manifest: &Value,
) -> Vec<ArtboardEntry> {
    let mut out = Vec::new();
    walk_manifest(manifest, &mut out);
    // Fallback when the manifest shape is unfamiliar: scan the archive.
    if out.is_empty() {
        for p in names {
            if let Some(id) = artboard_id_from_path(p) {
                out.push(ArtboardEntry {
                    id: id.into(),
                    path: p.clone(),
                    name: id.into(),
                    bounds: Value::Null,
                });
            }
        }
    }
    out.retain(|a| files.contains(&a.path));
    out
}

fn walk_manifest(node: &Value, out: &mut Vec<ArtboardEntry>) {
    if !node.is_object() {
        return;
    }
    if let Some(p) = node["path"].as_str().filter(|p| p.starts_with("artboard-")) {
        out.push(ArtboardEntry {
            id: p.into(),
            path: format!("artwork/{p}/graphics/graphicContent.agc"),
            name: js::string(js::or(&node["name"], &node["path"])),
            bounds: node["uxdesign#bounds"].clone(),
        });
    }
    for c in node["children"].as_array().into_iter().flatten() {
        walk_manifest(c, out);
    }
}

/// `artwork/(artboard-[^/]+)/graphics/graphicContent.agc` → the artboard id.
pub fn artboard_id_from_path(p: &str) -> Option<&str> {
    let id = p
        .strip_prefix("artwork/")?
        .strip_suffix("/graphics/graphicContent.agc")?;
    (id.len() > "artboard-".len() && id.starts_with("artboard-") && !id.contains('/')).then_some(id)
}

pub fn index_symbols<'a>(roots: &[&'a Value]) -> HashMap<String, &'a Value> {
    fn walk<'a>(v: &'a Value, map: &mut HashMap<String, &'a Value>) {
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, map)),
            Value::Object(o) => {
                if let (Some(id), true) = (
                    o.get("id").and_then(Value::as_str),
                    o.get("type").is_some_and(Value::is_string),
                ) {
                    map.insert(id.to_string(), v);
                }
                for (k, x) in o {
                    if k != "style" && k != "shape" && k != "text" {
                        walk(x, map);
                    }
                }
            }
            _ => {}
        }
    }
    let mut map = HashMap::new();
    for r in roots {
        walk(r, &mut map);
    }
    map
}

/// The artboard node of an artboard's scene graph, if any.
fn artboard_node(agc: &Value) -> &Value {
    agc["children"]
        .as_array()
        .and_then(|cs| cs.iter().find(|c| c["type"] == "artboard"))
        .unwrap_or(&NULL)
}

/// Size and pasteboard position of an artboard.
pub fn artboard_info(entry: &ArtboardEntry, agc: &Value, shared: &Value) -> ArtboardInfo {
    let ab_node = artboard_node(agc);
    let boards = &shared["artboards"];
    let r = js::string_or_empty(&ab_node["artboard"]["ref"]);
    let bare = entry.id.strip_prefix("artboard-").unwrap_or(&entry.id);
    let key = |k: &str| js::get(boards, &Value::from(k));
    let info = [
        key(&r),
        key(&format!("artboard-{r}")),
        key(&entry.id),
        key(bare),
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .unwrap_or(&NULL);
    let (b, ab) = (&entry.bounds, &ab_node["artboard"]);
    ArtboardInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
        path: entry.path.clone(),
        width: num(&info["width"], num(&b["width"], num(&ab["width"], 1.0))),
        height: num(&info["height"], num(&b["height"], num(&ab["height"], 1.0))),
        x: num(&info["x"], num(&b["x"], 0.0)),
        y: num(&info["y"], num(&b["y"], 0.0)),
    }
}

pub struct RenderedArtboard {
    pub id: String,
    pub name: String,
    pub width: f64,
    pub height: f64,
    pub svg: String,
    pub skipped: u32,
    pub layers: Vec<XdLayer>,
    pub image_needs: IndexMap<String, Size>,
}

pub fn render_artboard(
    files: &HashSet<String>,
    entry: &ArtboardEntry,
    agc: &Value,
    shared: &Value,
    symbols: &HashMap<String, &Value>,
) -> RenderedArtboard {
    let mut ctx = Ctx {
        files,
        gradients: Merged {
            shared: &shared["resources"]["gradients"],
            own: &agc["resources"]["gradients"],
        },
        clip_paths: Merged {
            shared: &shared["resources"]["clipPaths"],
            own: &agc["resources"]["clipPaths"],
        },
        defs: Vec::new(),
        ids: 0,
        skipped: 0,
        symbols,
        image_needs: IndexMap::new(),
        depth: 0,
        layer_ids: 0,
        layer_list: Vec::new(),
    };
    let ab_node = artboard_node(agc);
    let info = artboard_info(entry, agc, shared);
    let (width, height, ox, oy) = (info.width, info.height, info.x, info.y);

    let empty = Vec::new();
    let children: &[Value] = match ab_node["artboard"]["children"].as_array() {
        Some(c) => c,
        None if !ab_node["artboard"]["children"].is_null() => &empty,
        None if !ab_node.is_null() => &empty,
        None => agc["children"].as_array().unwrap_or(&empty),
    };
    let body: String = children
        .iter()
        .map(|c| render_node(&mut ctx, c, None))
        .collect();
    let layers = std::mem::take(&mut ctx.layer_list);

    let mut bg = String::new();
    if let Some(c) = color(&ab_node["style"]["fill"]["color"])
        .filter(|_| ab_node["style"]["fill"]["type"] != "none")
    {
        let op = if c.alpha < 1.0 {
            format!(r#" fill-opacity="{}""#, fmt(c.alpha))
        } else {
            String::new()
        };
        bg = format!(
            r#"<rect width="{}" height="{}" fill="{}"{op}/>"#,
            fmt(width),
            fmt(height),
            c.value
        );
    }

    // Children are stored in artboard-local coordinates in the files we've seen,
    // but older files use pasteboard coordinates. Detect the latter by voting;
    // the TS version breaks ties by measuring in the DOM, which isn't available here.
    let content = format!(r#"<g id="content">{body}</g>"#);
    let shift = pasteboard_vote(children, width, height, ox, oy) > 0;
    let placed = if shift {
        format!(
            r#"<g transform="translate({} {})">{content}</g>"#,
            fmt(-ox),
            fmt(-oy)
        )
    } else {
        content
    };

    let (w, h) = (fmt(width), fmt(height));
    let defs = if ctx.defs.is_empty() {
        String::new()
    } else {
        format!("<defs>{}</defs>", ctx.defs.join(""))
    };
    let svg = format!(
        r#"<svg xmlns="{SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><title>{}</title>{defs}<clipPath id="artboard-clip"><rect width="{w}" height="{h}"/></clipPath><g clip-path="url(#artboard-clip)">{bg}{placed}</g></svg>"#,
        esc(&entry.name)
    );

    RenderedArtboard {
        id: entry.id.clone(),
        name: entry.name.clone(),
        width,
        height,
        svg,
        skipped: ctx.skipped,
        layers,
        image_needs: ctx.image_needs,
    }
}

/// Do the top-level layers sit in pasteboard coordinates? Each layer's origin
/// votes for the rectangle it falls in: the artboard at its pasteboard
/// position (+1) or at 0,0 (-1). 0 means undecided.
fn pasteboard_vote(children: &[Value], w: f64, h: f64, ox: f64, oy: f64) -> i32 {
    if ox == 0.0 && oy == 0.0 {
        return -1;
    }
    let inside = |x: f64, y: f64, rx: f64, ry: f64| {
        x >= rx - 1.0 && x <= rx + w + 1.0 && y >= ry - 1.0 && y <= ry + h + 1.0
    };
    let mut score = 0;
    for c in children {
        let t = &c["transform"];
        if !truthy(t) || !(t.is_object() || t.is_array()) {
            continue;
        }
        let (x, y) = (num(&t["tx"], 0.0), num(&t["ty"], 0.0));
        score += inside(x, y, ox, oy) as i32 - inside(x, y, 0.0, 0.0) as i32;
    }
    score
}
