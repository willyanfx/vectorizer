//! Scene-graph traversal: groups, masks, component instances, scroll groups.
//! Port of packages/xd/src/render/nodes.ts.

use std::borrow::Cow;

use serde_json::{Map, Value};

use super::context::{Ctx, node_attrs, transform_attr, uid};
use super::shapes::{geometry, render_shape};
use super::text::{render_text, shown_text};
use crate::js::{self, fmt, num, truthy};
use crate::model::{LayerKind, XdLayer};

fn clip_for(ctx: &mut Ctx, node: &Value) -> String {
    let r = &node["style"]["clipPath"]["ref"];
    let own = if truthy(r) { ctx.clip_paths.get(r) } else { r };
    let res = js::or_truthy(own, &node["meta"]["ux"]["clipPathResources"]);
    let children = res["children"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if children.is_empty() {
        return String::new();
    }
    // <g> isn't allowed inside <clipPath>, so put each transform on the shape itself.
    let inner: String = children
        .iter()
        .map(|c| {
            let geo = if truthy(&c["shape"]) {
                geometry(&c["shape"])
            } else {
                None
            };
            geo.map_or(String::new(), |g| {
                format!("{}{}/>", g.el, transform_attr(&c["transform"]))
            })
        })
        .collect();
    if inner.is_empty() {
        return String::new();
    }
    let id = uid(ctx, "m");
    ctx.defs
        .push(format!(r#"<clipPath id="{id}">{inner}</clipPath>"#));
    format!(r#" clip-path="url(#{id})""#)
}

fn layer_kind(node: &Value) -> LayerKind {
    if node["type"] == "syncRef" {
        return LayerKind::Component;
    }
    if node["type"] == "text" {
        return LayerKind::Text;
    }
    if node["type"] == "shape" || (!truthy(&node["group"]) && truthy(&node["shape"])) {
        return if node["style"]["fill"]["type"] == "pattern" {
            LayerKind::Image
        } else {
            LayerKind::Shape
        };
    }
    if truthy(&node["style"]["clipPath"]["ref"]) || truthy(&node["meta"]["ux"]["clipPathResources"])
    {
        return LayerKind::Mask;
    }
    LayerKind::Group
}

fn layer_name(node: &Value, kind: LayerKind) -> String {
    if kind == LayerKind::Text {
        let raw = js::or(
            &node["text"]["rawText"],
            js::or(&node["name"], &Value::Null),
        );
        let t = js::string_or_empty(raw);
        let t = js::collapse_spaces(&t);
        let t = js::JsStr::new(js::trim(&t));
        if !t.is_empty() {
            if t.len() > 48 {
                return format!("{}…", t.slice(0.0, 47.0));
            }
            return t.to_string();
        }
    }
    if let Some(name) = node["name"]
        .as_str()
        .map(js::trim)
        .filter(|n| !n.is_empty())
    {
        return name.to_string();
    }
    let k = kind.as_str();
    k[..1].to_uppercase() + &k[1..]
}

/// `{ ...a, ...b }` for objects.
fn spread(a: &Value, b: impl IntoIterator<Item = (String, Value)>) -> Map<String, Value> {
    let mut out = a.as_object().cloned().unwrap_or_default();
    for (k, v) in b {
        out.insert(k, v);
    }
    out
}

fn entries(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// Instance properties layered over the master node's (transform, style, scroll viewport…).
fn overlay(master: &Value, inst: &Value) -> Value {
    let mut out = entries(master);
    for k in ["transform", "visible", "name"] {
        if let Some(v) = inst.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    if truthy(&inst["style"]) {
        out.insert(
            "style".into(),
            Value::Object(spread(&master["style"], entries(&inst["style"]))),
        );
    }
    if truthy(&inst["meta"]["ux"]) {
        let ux = spread(&master["meta"]["ux"], entries(&inst["meta"]["ux"]));
        out.insert(
            "meta".into(),
            Value::Object(spread(
                &master["meta"],
                [("ux".to_string(), Value::Object(ux))],
            )),
        );
    }
    Value::Object(out)
}

/// The master node a syncRef stands for, with the syncRef's own overrides applied.
fn master_of(ctx: &Ctx, node: &Value, hops: u32) -> Option<Value> {
    let src = *node["syncSourceGuid"]
        .as_str()
        .and_then(|id| ctx.symbols.get(id))?;
    if hops > 16 {
        return None;
    }
    let base = if src["type"] == "syncRef" {
        Cow::Owned(master_of(ctx, src, hops + 1)?)
    } else {
        Cow::Borrowed(src)
    };
    Some(overlay(&base, node))
}

/// Scroll groups show only their viewport (XD exports the unscrolled view).
fn scroll_clip(ctx: &mut Ctx, node: &Value) -> String {
    let ux = &node["meta"]["ux"];
    let ty = &ux["scrollingType"];
    if !truthy(ty) {
        return String::new();
    }
    const BIG: f64 = 1e6;
    let w = if *ty == "vertical" {
        0.0
    } else {
        num(&ux["viewportWidth"], 0.0)
    };
    let h = if *ty == "horizontal" {
        0.0
    } else {
        num(&ux["viewportHeight"], 0.0)
    };
    if w <= 0.0 && h <= 0.0 {
        return String::new();
    }
    let id = uid(ctx, "m");
    let (x, cw) = if w > 0.0 { (0.0, w) } else { (-BIG / 2.0, BIG) };
    let (y, ch) = if h > 0.0 { (0.0, h) } else { (-BIG / 2.0, BIG) };
    ctx.defs.push(format!(
        r#"<clipPath id="{id}"><rect x="{}" y="{}" width="{}" height="{}"/></clipPath>"#,
        fmt(x),
        fmt(y),
        fmt(cw),
        fmt(ch)
    ));
    format!(r#" clip-path="url(#{id})""#)
}

pub fn render_node(ctx: &mut Ctx, node: &Value, as_: Option<&Value>) -> String {
    if !truthy(node) || node["visible"] == false {
        return String::new();
    }
    if ctx.depth > 64 {
        ctx.skipped += 1;
        return String::new();
    }
    let mut node = Cow::Borrowed(node);
    if node["type"] == "syncRef" {
        let Some(src) = master_of(ctx, &node, 0) else {
            ctx.skipped += 1;
            return String::new();
        };
        if node["group"]["children"].is_array() {
            // An instance's own copy of a master group: the children are the
            // instance's (with overrides), everything else comes from the master.
            let group = spread(
                &src["group"],
                [("children".to_string(), node["group"]["children"].clone())],
            );
            let merged = spread(&src, [("group".to_string(), Value::Object(group))]);
            node = Cow::Owned(Value::Object(merged));
            if node["visible"] == false {
                return String::new();
            }
        } else {
            // A childless syncRef is a linked copy of a node inside a component master.
            ctx.depth += 1;
            // The instance's own layer entry describes the master's node.
            let out = render_node(ctx, &src, Some(as_.unwrap_or(&node)));
            ctx.depth -= 1;
            return out;
        }
    }

    let kind = if as_.is_some() {
        LayerKind::Component
    } else {
        layer_kind(&node)
    };
    let name_src = match as_ {
        Some(a) if truthy(&a["name"]) => a,
        _ => &node,
    };
    ctx.layer_ids += 1;
    let mut layer = XdLayer {
        key: format!("xl{}", ctx.layer_ids),
        name: layer_name(
            name_src,
            if kind == LayerKind::Component {
                layer_kind(&node)
            } else {
                kind
            },
        ),
        kind,
        children: Vec::new(),
        text: (node["type"] == "text").then(|| shown_text(&node)),
    };
    let parent = std::mem::take(&mut ctx.layer_list);
    ctx.depth += 1;
    let out = render_node_inner(ctx, &node);
    ctx.depth -= 1;
    layer.children = std::mem::replace(&mut ctx.layer_list, parent);
    let Some(rest) = out.strip_prefix("<g") else {
        return out;
    };
    let key = layer.key.clone();
    ctx.layer_list.push(layer);
    format!(r#"<g id="{key}"{rest}"#)
}

fn render_node_inner(ctx: &mut Ctx, node: &Value) -> String {
    match node["type"].as_str() {
        Some("shape") => render_shape(ctx, node),
        Some("text") => render_text(ctx, node),
        // group, syncRef (component instance), repeat grid, boolean group…
        _ => {
            let kids = js::or(&node["group"]["children"], &node["children"]);
            if let Some(kids) = kids.as_array() {
                let clip = clip_for(ctx, node);
                let scroll = scroll_clip(ctx, node);
                let mut inner: String = kids.iter().map(|k| render_node(ctx, k, None)).collect();
                if !scroll.is_empty() && !clip.is_empty() {
                    inner = format!("<g{scroll}>{inner}</g>");
                }
                let attrs = node_attrs(ctx, node);
                let mask = if clip.is_empty() { scroll } else { clip };
                return format!("<g{attrs}{mask}>{inner}</g>");
            }
            if truthy(&node["shape"]) {
                return render_shape(ctx, node);
            }
            ctx.skipped += 1;
            String::new()
        }
    }
}
