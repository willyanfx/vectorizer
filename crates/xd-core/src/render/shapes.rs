//! Shapes. Port of packages/xd/src/render/shapes.ts.

use serde_json::Value;

use super::context::{Ctx, image_href, node_attrs, paint_attrs, uid};
use crate::js::{self, esc, fmt, num, truthy};

pub type BBox = [f64; 4];

/// Geometry element (no paint, not closed) + its bounding box.
pub struct Geometry {
    pub el: String,
    pub bbox: BBox,
}

/// `x + r` where r may be missing (`undefined` → NaN).
fn add(x: f64, r: Option<f64>) -> f64 {
    x + r.unwrap_or(f64::NAN)
}

fn set(r: Option<f64>) -> Option<f64> {
    r.filter(|v| *v != 0.0 && !v.is_nan())
}

fn rect_path(x: f64, y: f64, w: f64, h: f64, r: &[f64]) -> String {
    let c = |i: usize| r.get(i).map(|v| js::min(js::min(*v, w / 2.0), h / 2.0));
    let (tl, tr, br, bl) = (c(0), c(1), c(2), c(3));
    let neg = |v: Option<f64>| v.map(|v| -v);
    let mut d = format!(
        "M{} {}H{}",
        fmt(add(x, tl)),
        fmt(y),
        fmt(add(x + w, neg(tr)))
    );
    if let Some(tr) = set(tr) {
        d += &format!(
            "A{} {} 0 0 1 {} {}",
            fmt(tr),
            fmt(tr),
            fmt(x + w),
            fmt(y + tr)
        );
    }
    d += &format!("V{}", fmt(add(y + h, neg(br))));
    if let Some(br) = set(br) {
        d += &format!(
            "A{} {} 0 0 1 {} {}",
            fmt(br),
            fmt(br),
            fmt(x + w - br),
            fmt(y + h)
        );
    }
    d += &format!("H{}", fmt(add(x, bl)));
    if let Some(bl) = set(bl) {
        d += &format!(
            "A{} {} 0 0 1 {} {}",
            fmt(bl),
            fmt(bl),
            fmt(x),
            fmt(y + h - bl)
        );
    }
    d += &format!("V{}", fmt(add(y, tl)));
    if let Some(tl) = set(tl) {
        d += &format!("A{} {} 0 0 1 {} {}", fmt(tl), fmt(tl), fmt(x + tl), fmt(y));
    }
    d + "Z"
}

pub fn geometry(shape: &Value) -> Option<Geometry> {
    let g = |k: &str| num(&shape[k], 0.0);
    match shape["type"].as_str() {
        Some("rect") => {
            let (x, y, w, h) = (g("x"), g("y"), g("width"), g("height"));
            let r: Vec<f64> = match shape["r"].as_array() {
                Some(a) => a.iter().map(|v| num(v, 0.0)).collect(),
                None => vec![g("r"); 4],
            };
            let bbox = [x, y, w, h];
            if r.iter().all(|v| *v == r[0]) {
                let rr = match r.first().filter(|v| **v != 0.0) {
                    Some(r0) => {
                        format!(r#" rx="{}""#, fmt(js::min(js::min(*r0, w / 2.0), h / 2.0)))
                    }
                    None => String::new(),
                };
                let el = format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}"{rr}"#,
                    fmt(x),
                    fmt(y),
                    fmt(w),
                    fmt(h)
                );
                return Some(Geometry { el, bbox });
            }
            Some(Geometry {
                el: format!(r#"<path d="{}""#, rect_path(x, y, w, h, &r)),
                bbox,
            })
        }
        Some("ellipse") => {
            let (cx, cy, rx, ry) = (g("cx"), g("cy"), g("rx"), g("ry"));
            Some(Geometry {
                el: format!(
                    r#"<ellipse cx="{}" cy="{}" rx="{}" ry="{}""#,
                    fmt(cx),
                    fmt(cy),
                    fmt(rx),
                    fmt(ry)
                ),
                bbox: [cx - rx, cy - ry, rx * 2.0, ry * 2.0],
            })
        }
        Some("circle") => {
            let (cx, cy, r) = (g("cx"), g("cy"), g("r"));
            Some(Geometry {
                el: format!(
                    r#"<circle cx="{}" cy="{}" r="{}""#,
                    fmt(cx),
                    fmt(cy),
                    fmt(r)
                ),
                bbox: [cx - r, cy - r, r * 2.0, r * 2.0],
            })
        }
        Some("line") => {
            let (x1, y1, x2, y2) = (g("x1"), g("y1"), g("x2"), g("y2"));
            Some(Geometry {
                el: format!(
                    r#"<line x1="{}" y1="{}" x2="{}" y2="{}""#,
                    fmt(x1),
                    fmt(y1),
                    fmt(x2),
                    fmt(y2)
                ),
                bbox: [x1.min(x2), y1.min(y2), (x2 - x1).abs(), (y2 - y1).abs()],
            })
        }
        Some(t @ ("polygon" | "polyline")) => {
            // Polygons usually also carry a precomputed path; prefer that.
            match shape["points"].as_array() {
                Some(pts) if !truthy(&shape["path"]) => {
                    let xs: Vec<f64> = pts.iter().map(|p| num(&p["x"], 0.0)).collect();
                    let ys: Vec<f64> = pts.iter().map(|p| num(&p["y"], 0.0)).collect();
                    let lo = |v: &[f64]| v.iter().fold(f64::INFINITY, |a, b| a.min(*b));
                    let hi = |v: &[f64]| v.iter().fold(f64::NEG_INFINITY, |a, b| a.max(*b));
                    let (min_x, min_y) = (lo(&xs), lo(&ys));
                    let points: Vec<String> = xs
                        .iter()
                        .zip(&ys)
                        .map(|(x, y)| format!("{},{}", fmt(*x), fmt(*y)))
                        .collect();
                    Some(Geometry {
                        el: format!(r#"<{t} points="{}""#, points.join(" ")),
                        bbox: [min_x, min_y, hi(&xs) - min_x, hi(&ys) - min_y],
                    })
                }
                _ => path_geometry(shape),
            }
        }
        // path, compound (boolean ops are pre-flattened into .path), unknown
        _ => path_geometry(shape),
    }
}

fn path_geometry(shape: &Value) -> Option<Geometry> {
    let path = shape["path"].as_str().filter(|p| !p.is_empty())?;
    let rule = if shape["fillRule"] == "evenodd" || shape["winding"] == "evenodd" {
        r#" fill-rule="evenodd""#
    } else {
        ""
    };
    Some(Geometry {
        el: format!(r#"<path d="{}"{rule}"#, esc(path)),
        bbox: path_box(shape, path),
    })
}

/// The numbers in a path, as `/-?\d*\.?\d+(?:e[-+]?\d+)?/gi` finds them.
fn path_numbers(s: &str) -> Vec<f64> {
    let b = s.as_bytes();
    let digits = |mut i: usize| {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        i
    };
    // End of `\d*\.?\d+` starting at j, if it matches.
    let body = |j: usize| -> Option<usize> {
        let a = digits(j);
        if a > j && b.get(a) == Some(&b'.') && b.get(a + 1).is_some_and(u8::is_ascii_digit) {
            Some(digits(a + 1))
        } else if a > j {
            Some(a)
        } else if b.get(j) == Some(&b'.') && b.get(j + 1).is_some_and(u8::is_ascii_digit) {
            Some(digits(j + 1))
        } else {
            None
        }
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let m = if b[i] == b'-' { body(i + 1) } else { None }.or_else(|| body(i));
        let Some(mut end) = m else {
            i += 1;
            continue;
        };
        if matches!(b.get(end), Some(b'e' | b'E')) {
            let mut k = end + 1;
            if matches!(b.get(k), Some(b'-' | b'+')) {
                k += 1;
            }
            let e = digits(k);
            if e > k {
                end = e;
            }
        }
        out.push(s[i..end].parse().unwrap_or(f64::NAN));
        i = end;
    }
    out
}

/// Approximate bbox of an XD path (XD writes absolute M/L/C/Z commands).
fn path_box(shape: &Value, path: &str) -> BBox {
    let (w, h) = (num(&shape["width"], 0.0), num(&shape["height"], 0.0));
    if w != 0.0 && h != 0.0 {
        return [0.0, 0.0, w, h];
    }
    let nums = path_numbers(path);
    if nums.len() < 2 {
        return [0.0; 4];
    }
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for [x, y] in nums.as_chunks::<2>().0 {
        x0 = js::min(x0, *x);
        x1 = js::max(x1, *x);
        y0 = js::min(y0, *y);
        y1 = js::max(y1, *y);
    }
    [x0, y0, x1 - x0, y1 - y0]
}

/// `s.replace(/ fill="[^"]*"/, ' fill="none"')`.
fn unfill(s: &str) -> String {
    if let Some(i) = s.find(r#" fill=""#) {
        let start = i + r#" fill=""#.len();
        if let Some(j) = s[start..].find('"') {
            return format!(r#"{} fill="none"{}"#, &s[..i], &s[start + j + 1..]);
        }
    }
    s.to_string()
}

pub fn render_shape(ctx: &mut Ctx, node: &Value) -> String {
    let Some(geo) = geometry(&node["shape"]) else {
        ctx.skipped += 1;
        return String::new();
    };
    let style = &node["style"];
    let attrs = node_attrs(ctx, node);
    let shape_el = format!("{}{}/>", geo.el, paint_attrs(ctx, style, false));
    if style["fill"]["type"] != "pattern" {
        return format!("<g{attrs}>{shape_el}</g>");
    }

    // Image fill: clip the image to the shape, then draw the stroke on top.
    let pattern = &style["fill"]["pattern"];
    let [x, y, mut w, mut h] = geo.bbox;
    if w == 0.0 || h == 0.0 || w.is_nan() || h.is_nan() {
        w = num(&pattern["width"], 0.0);
        h = num(&pattern["height"], 0.0);
    }
    let Some(href) = image_href(ctx, pattern, w, h) else {
        return format!("<g{attrs}>{shape_el}</g>");
    };
    let clip_id = uid(ctx, "c");
    ctx.defs.push(format!(
        r#"<clipPath id="{clip_id}">{}/></clipPath>"#,
        geo.el
    ));
    let fit = if pattern["meta"]["ux"]["scaleBehavior"] == "fill" {
        "none"
    } else {
        "xMidYMid slice"
    };
    format!(
        r#"<g{attrs}><g clip-path="url(#{clip_id})"><image x="{}" y="{}" width="{}" height="{}" preserveAspectRatio="{fit}" xlink:href="{href}"/></g>{}</g>"#,
        fmt(x),
        fmt(y),
        fmt(w),
        fmt(h),
        unfill(&shape_el),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_path_numbers_like_the_js_regex() {
        assert_eq!(
            path_numbers("M10 20L-3.5.5C1e2,2E-1 7."),
            vec![10.0, 20.0, -3.5, 0.5, 100.0, 0.2, 7.0]
        );
        assert_eq!(path_numbers("M-.5 1e"), vec![-0.5, 1.0]);
    }
}
