//! Render context + paint/transform/filter attributes shared by every node type.
//! Port of packages/xd/src/render/context.ts.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use crate::js::{self, NULL, esc, fmt, num, truthy};
use crate::model::{Size, XdLayer};

pub struct Color {
    pub value: String,
    pub alpha: f64,
}

/// `ToUint32`.
fn to_u32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4294967296.0) as u32
}

pub fn color(c: &Value) -> Option<Color> {
    if !truthy(c) {
        return None;
    }
    let v = js::or(&c["value"], c);
    // Ranged text styles store colors as one ARGB integer.
    if let Some(x) = v.as_f64().filter(|x| x.is_finite()) {
        let hex = format!("{:08x}", to_u32(x));
        let a = u8::from_str_radix(&hex[..2], 16).unwrap_or(0) as f64 / 255.0;
        return Some(Color {
            value: format!("#{}", &hex[2..]),
            alpha: num(&c["alpha"], a),
        });
    }
    if v.as_object().is_some_and(|m| m.contains_key("r")) {
        let hex: String = ["r", "g", "b"]
            .iter()
            .map(|k| {
                format!(
                    "{:02x}",
                    js::round(num(&v[*k], 0.0)).clamp(0.0, 255.0) as u8
                )
            })
            .collect();
        return Some(Color {
            value: format!("#{hex}"),
            alpha: num(&c["alpha"], 1.0),
        });
    }
    None
}

/// `{ ...shared, ...own }` lookups without building the merged object.
pub struct Merged<'a> {
    pub shared: &'a Value,
    pub own: &'a Value,
}

impl<'a> Merged<'a> {
    pub fn get(&self, key: &Value) -> &'a Value {
        let k = js::string(key);
        let pick = |v: &'a Value| v.as_object().and_then(|m| m.get(&k));
        pick(self.own)
            .or_else(|| pick(self.shared))
            .unwrap_or(&NULL)
    }
}

pub struct Ctx<'a> {
    pub files: &'a HashSet<String>,
    pub gradients: Merged<'a>,
    pub clip_paths: Merged<'a>,
    pub defs: Vec<String>,
    pub ids: u32,
    pub skipped: u32,
    /// Component masters + pasteboard nodes by id, for resolving syncRef instances.
    pub symbols: &'a HashMap<String, &'a Value>,
    /// Images referenced by this artboard: uid → largest displayed size (px).
    pub image_needs: IndexMap<String, Size>,
    pub depth: u32,
    pub layer_ids: u32,
    /// Children list of the layer currently being rendered.
    pub layer_list: Vec<XdLayer>,
}

pub fn uid(ctx: &mut Ctx, p: &str) -> String {
    ctx.ids += 1;
    format!("{p}{}", ctx.ids)
}

pub fn transform_attr(t: &Value) -> String {
    if !(t.is_object() || t.is_array()) {
        return String::new();
    }
    // Destructuring defaults apply to missing keys only (not to null).
    let field = |k: &str, d: f64| t.get(k).cloned().unwrap_or_else(|| Value::from(d));
    let (a, b, c, d) = (
        field("a", 1.0),
        field("b", 0.0),
        field("c", 0.0),
        field("d", 1.0),
    );
    let (tx, ty) = (field("tx", 0.0), field("ty", 0.0));
    let is = |v: &Value, x: f64| v.as_f64() == Some(x);
    if is(&a, 1.0) && is(&b, 0.0) && is(&c, 0.0) && is(&d, 1.0) {
        return if truthy(&tx) || truthy(&ty) {
            format!(
                r#" transform="translate({} {})""#,
                fmt(js::to_number(&tx)),
                fmt(js::to_number(&ty))
            )
        } else {
            String::new()
        };
    }
    let parts: Vec<String> = [a, b, c, d, tx, ty]
        .iter()
        .map(|x| fmt(num(x, 0.0)))
        .collect();
    format!(r#" transform="matrix({})""#, parts.join(" "))
}

fn has_key(v: &Value, k: &str) -> bool {
    v.as_object().is_some_and(|m| m.contains_key(k))
}

pub fn gradient_def(ctx: &mut Ctx, g: &Value) -> Option<String> {
    let res = js::or(
        ctx.gradients.get(&g["ref"]),
        &g["meta"]["ux"]["gradientResources"],
    );
    let stops = res["stops"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if stops.is_empty() {
        return None;
    }
    let id = uid(ctx, "g");
    let units = if g["units"] == "userSpaceOnUse" {
        "userSpaceOnUse"
    } else {
        "objectBoundingBox"
    };
    let stop_xml: String = stops
        .iter()
        .map(|s| match color(&s["color"]) {
            None => String::new(),
            Some(c) => {
                let op = if c.alpha < 1.0 {
                    format!(r#" stop-opacity="{}""#, fmt(c.alpha))
                } else {
                    String::new()
                };
                format!(
                    r#"<stop offset="{}" stop-color="{}"{op}/>"#,
                    fmt(num(&s["offset"], 0.0)),
                    c.value
                )
            }
        })
        .collect();
    let gt = &g["gradientTransform"];
    let gt = if truthy(gt) {
        let m: Vec<String> = ["a", "b", "c", "d", "tx", "ty"]
            .iter()
            .map(|k| fmt(num(&gt[*k], if *k == "a" || *k == "d" { 1.0 } else { 0.0 })))
            .collect();
        format!(r#" gradientTransform="matrix({})""#, m.join(" "))
    } else {
        String::new()
    };
    if *js::or(&res["type"], &g["type"]) == "radial" || has_key(g, "r") {
        let f = if has_key(g, "fx") {
            format!(
                r#" fx="{}" fy="{}""#,
                fmt(num(&g["fx"], 0.0)),
                fmt(num(&g["fy"], 0.0))
            )
        } else {
            String::new()
        };
        ctx.defs.push(format!(
            r#"<radialGradient id="{id}" gradientUnits="{units}" cx="{}" cy="{}" r="{}"{f}{gt}>{stop_xml}</radialGradient>"#,
            fmt(num(&g["cx"], 0.5)),
            fmt(num(&g["cy"], 0.5)),
            fmt(num(&g["r"], 0.5)),
        ));
    } else {
        ctx.defs.push(format!(
            r#"<linearGradient id="{id}" gradientUnits="{units}" x1="{}" y1="{}" x2="{}" y2="{}"{gt}>{stop_xml}</linearGradient>"#,
            fmt(num(&g["x1"], 0.0)),
            fmt(num(&g["y1"], 0.0)),
            fmt(num(&g["x2"], 1.0)),
            fmt(num(&g["y2"], 0.0)),
        ));
    }
    Some(format!("url(#{id})"))
}

// Images are emitted as placeholders and swapped for (downscaled) data URIs
// afterwards — embedding a 30 MB PNG as-is would make the SVG/PDF unusable.
pub fn img_token(key: &str) -> String {
    format!("__XDIMG_{key}__")
}

pub fn is_image_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

pub fn image_href(ctx: &mut Ctx, pattern: &Value, w: f64, h: f64) -> Option<String> {
    let uid = &pattern["meta"]["ux"]["uid"];
    let key = if !uid.is_null() {
        js::string(uid)
    } else {
        let href = pattern["href"].as_str()?;
        href.strip_prefix('/').unwrap_or(href).to_string()
    };
    if !is_image_key(&key) || !ctx.files.contains(&format!("resources/{key}")) {
        return None;
    }
    let prev = ctx
        .image_needs
        .get(&key)
        .copied()
        .unwrap_or(Size { w: 0.0, h: 0.0 });
    ctx.image_needs.insert(
        key.clone(),
        Size {
            w: js::max(prev.w, w),
            h: js::max(prev.h, h),
        },
    );
    Some(img_token(&key))
}

/// fill / stroke / opacity / filter attributes for a node's style.
pub fn paint_attrs(ctx: &mut Ctx, style: &Value, is_text: bool) -> String {
    let mut out = String::new();
    let fill = &style["fill"];
    let ty = &fill["type"];
    if !truthy(fill) || *ty == "none" {
        out += r#" fill="none""#;
    } else if *ty == "solid" || (truthy(&fill["color"]) && !truthy(ty)) {
        match color(&fill["color"]) {
            Some(c) => {
                out += &format!(r#" fill="{}""#, c.value);
                if c.alpha < 1.0 {
                    out += &format!(r#" fill-opacity="{}""#, fmt(c.alpha));
                }
            }
            None => out += r#" fill="none""#,
        }
    } else if *ty == "gradient" && truthy(&fill["gradient"]) {
        let paint = gradient_def(ctx, &fill["gradient"]).unwrap_or_else(|| "none".into());
        out += &format!(r#" fill="{paint}""#);
    } else if *ty == "pattern" || !is_text {
        // pattern: the image is drawn separately, clipped to the shape
        out += r#" fill="none""#;
    }

    let stroke = &style["stroke"];
    if truthy(stroke) && stroke["type"] != "none" && num(&stroke["width"], 0.0) > 0.0 {
        let mut paint = None;
        let mut alpha = 1.0;
        if stroke["type"] == "gradient" && truthy(&stroke["gradient"]) {
            paint = gradient_def(ctx, &stroke["gradient"]);
        } else if let Some(c) = color(&stroke["color"]) {
            paint = Some(c.value);
            alpha = c.alpha;
        }
        if let Some(paint) = paint {
            out += &format!(
                r#" stroke="{paint}" stroke-width="{}""#,
                fmt(num(&stroke["width"], 0.0))
            );
            if alpha < 1.0 {
                out += &format!(r#" stroke-opacity="{}""#, fmt(alpha));
            }
            if truthy(&stroke["cap"]) {
                out += &format!(r#" stroke-linecap="{}""#, esc(&js::string(&stroke["cap"])));
            }
            if truthy(&stroke["join"]) {
                out += &format!(
                    r#" stroke-linejoin="{}""#,
                    esc(&js::string(&stroke["join"]))
                );
            }
            if truthy(&stroke["miterLimit"]) {
                out += &format!(
                    r#" stroke-miterlimit="{}""#,
                    fmt(num(&stroke["miterLimit"], 0.0))
                );
            }
            if let Some(dash) = stroke["dash"].as_array().filter(|d| !d.is_empty()) {
                let d: Vec<String> = dash.iter().map(|d| fmt(num(d, 0.0))).collect();
                out += &format!(r#" stroke-dasharray="{}""#, d.join(" "));
            }
        }
    }
    out
}

pub fn node_attrs(ctx: &mut Ctx, node: &Value) -> String {
    let style = &node["style"];
    let mut out = transform_attr(&node["transform"]);
    if !style["opacity"].is_null() && num(&style["opacity"], 1.0) < 1.0 {
        out += &format!(r#" opacity="{}""#, fmt(num(&style["opacity"], 0.0)));
    }
    let blend = &style["blendMode"];
    if truthy(blend) && *blend != "pass-through" && *blend != "normal" {
        out += &format!(r#" style="mix-blend-mode:{}""#, esc(&js::string(blend)));
    }

    let mut prims = Vec::new();
    for f in style["filters"].as_array().into_iter().flatten() {
        let p = &f["params"];
        if f["visible"] == false || p["visible"] == false {
            continue;
        }
        if f["type"] == "dropShadow" {
            for s in p["dropShadowList"].as_array().into_iter().flatten() {
                let Some(c) = color(&s["color"]) else {
                    continue;
                };
                prims.push(format!(
                    r#"<feDropShadow dx="{}" dy="{}" stdDeviation="{}" flood-color="{}" flood-opacity="{}"/>"#,
                    fmt(num(&s["dx"], 0.0)),
                    fmt(num(&s["dy"], 0.0)),
                    fmt(num(&s["r"], 0.0) / 2.0),
                    c.value,
                    fmt(c.alpha),
                ));
            }
        } else if f["type"] == "uxdesign#blur" || f["type"] == "blur" {
            let r = num(js::or(&p["blurAmount"], &p["r"]), 0.0);
            if r > 0.0 && !truthy(&p["backgroundEffect"]) {
                prims.push(format!(
                    r#"<feGaussianBlur stdDeviation="{}"/>"#,
                    fmt(r / 2.0)
                ));
            }
        }
    }
    if !prims.is_empty() {
        let id = uid(ctx, "f");
        ctx.defs.push(format!(
            r#"<filter id="{id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">{}</filter>"#,
            prims.join("")
        ));
        out += &format!(r#" filter="url(#{id})""#);
    }
    out
}
