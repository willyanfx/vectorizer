//! Text. Port of packages/xd/src/render/text.ts.
//!
//! XD stores text ranges in UTF-16 code units, so all slicing goes through
//! [`JsStr`].

use serde_json::Value;

use super::context::{Color, Ctx, color, node_attrs, paint_attrs};
use crate::js::{self, JsStr, esc, fmt, num, truthy};

/// Font weight by keyword; first match wins (so "Extra Bold" is not "Bold").
fn weight(st: &str) -> Option<u32> {
    let s = st.to_lowercase();
    let has = |a: &str, b: &str| s.contains(&format!("{a}{b}")) || s.contains(&format!("{a} {b}"));
    let table: [(bool, u32); 8] = [
        (s.contains("thin") || s.contains("hairline"), 100),
        (has("extra", "light") || has("ultra", "light"), 200),
        (s.contains("light"), 300),
        (s.contains("medium"), 500),
        (
            has("semi", "bold") || has("demi", "bold") || has("sm", "bold"),
            600,
        ),
        (has("extra", "bold") || has("ultra", "bold"), 800),
        (s.contains("black") || s.contains("heavy"), 900),
        (s.contains("bold"), 700),
    ];
    table.into_iter().find(|(hit, _)| *hit).map(|(_, w)| w)
}

struct FontSpec<'a> {
    family: &'a Value,
    style: &'a Value,
    postscript_name: &'a Value,
    size: &'a Value,
}

impl<'a> FontSpec<'a> {
    fn of(font: &'a Value) -> Self {
        FontSpec {
            family: &font["family"],
            style: &font["style"],
            postscript_name: &font["postscriptName"],
            size: &font["size"],
        }
    }
}

fn font_attrs(font: Option<FontSpec>) -> String {
    let Some(font) = font else {
        return String::new();
    };
    let mut out = String::new();
    // Most specific name first. XD families often hold many widths of one weight
    // ("Sharp Grotesk Bold" 05–25), so the bare family can resolve to the wrong
    // width; the PostScript name ("SharpGroteskBold19") picks the exact face.
    let mut names: Vec<String> = Vec::new();
    if truthy(font.postscript_name) {
        names.push(js::string(font.postscript_name));
    }
    let family = js::string(font.family);
    let style = js::string(font.style);
    if truthy(font.family)
        && family.contains(' ')
        && truthy(font.style)
        && !style.is_empty()
        && style.bytes().all(|b| b.is_ascii_digit())
    {
        names.push(format!("{family} {style}"));
    }
    if truthy(font.family) {
        names.push(family);
    }
    let mut unique: Vec<String> = Vec::new();
    for n in names {
        if !unique.contains(&n) {
            unique.push(n);
        }
    }
    if !unique.is_empty() {
        let list: Vec<String> = unique
            .iter()
            .map(|f| format!("'{}'", f.replace('\'', "")))
            .collect();
        out += &format!(
            r#" font-family="{}""#,
            esc(&format!("{}, sans-serif", list.join(", ")))
        );
    }
    if truthy(font.size) {
        out += &format!(r#" font-size="{}""#, fmt(num(font.size, 0.0)));
    }
    // XD often encodes weight in the family ("Sharp Grotesk Bold") with a numeric style ("19").
    let st = format!(
        "{} {} {}",
        js::string_or_empty(font.family),
        js::string_or_empty(font.style),
        js::string_or_empty(font.postscript_name)
    );
    if let Some(w) = weight(&st) {
        out += &format!(r#" font-weight="{w}""#);
    }
    let lower = st.to_lowercase();
    if lower.contains("italic") || lower.contains("oblique") {
        out += r#" font-style="italic""#;
    }
    out
}

/// `fontAttrs(font)` for a style's `font` value (`''` when falsy).
fn font_attrs_of(font: &Value) -> String {
    font_attrs(truthy(font).then(|| FontSpec::of(font)))
}

fn fill_attr(c: Option<Color>) -> String {
    match c {
        Some(c) if c.alpha < 1.0 => {
            format!(r#" fill="{}" fill-opacity="{}""#, c.value, fmt(c.alpha))
        }
        Some(c) => format!(r#" fill="{}""#, c.value),
        None => String::new(),
    }
}

fn apply_case(s: &JsStr, mode: &Value) -> JsStr {
    let text = s.to_string();
    match mode.as_str() {
        Some("uppercase") => JsStr::new(&text.to_uppercase()),
        Some("lowercase") => JsStr::new(&text.to_lowercase()),
        Some("titlecase") => {
            // s.replace(/(^|\s)(\S)/g, …): uppercase each code unit after start or
            // whitespace. Astral characters are two code units, so JS leaves them.
            let mut out = String::with_capacity(text.len());
            let mut after_space = true;
            for c in text.chars() {
                if after_space && !js::is_space_char(c) && (c as u32) < 0x10000 {
                    out.extend(c.to_uppercase());
                } else {
                    out.push(c);
                }
                after_space = js::is_space_char(c);
            }
            JsStr::new(&out)
        }
        _ => s.clone(),
    }
}

/// x of the alignment anchor for centered / right-aligned text, or None to
/// place each line at XD's measured left edge. See text.ts for the cases.
fn text_anchor_x(t: &Value, align: &Value, xs: &[f64]) -> Option<f64> {
    let ty = &t["frame"]["type"];
    let w = num(&t["frame"]["width"], 0.0);
    let all = |ok: &dyn Fn(f64) -> bool| xs.iter().all(|x| ok(*x));
    let has_w = w != 0.0;
    if *align == "center" {
        if *ty == "area" {
            return (has_w && all(&|x| x >= -1.0 && x <= w / 2.0 + 1.0)).then_some(w / 2.0);
        }
        if *ty == "autoHeight" {
            return (has_w && all(&|x| x <= 1.0 && x >= -w / 2.0 - 1.0)).then_some(w / 2.0);
        }
        return all(&|x| x <= 1.0).then_some(0.0);
    }
    if *align == "right" {
        if *ty == "area" {
            return (has_w && all(&|x| x >= -1.0 && x <= w + 1.0)).then_some(w);
        }
        if *ty == "autoHeight" {
            return None; // no samples seen; keep XD's measured positions
        }
        return all(&|x| x <= 1.0).then_some(0.0);
    }
    None
}

pub struct Range<'a> {
    from: f64,
    to: f64,
    s: &'a Value,
}

/// A text node's ranged styles and its text as displayed.
pub fn text_runs(node: &Value) -> (Vec<Range<'_>>, JsStr) {
    let raw = JsStr::new(node["text"]["rawText"].as_str().unwrap_or(""));
    let raw_len = raw.len() as f64;
    // Ranged styles: [{length, fontFamily, fontSize, fill, textTransform…}] covering rawText.
    let mut ranges = Vec::new();
    let mut pos = 0.0;
    for r in node["meta"]["ux"]["rangedStyles"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let len = num(&r["length"], 0.0);
        ranges.push(Range {
            from: pos,
            to: pos + len,
            s: r,
        });
        pos += len;
    }
    // Ranged styles may stop short of the end of the text; the last style carries on.
    if let Some(last) = ranges.last_mut().filter(|_| pos < raw_len) {
        last.to = raw_len;
        pos = raw_len;
    }
    // Text as displayed (XD's "uppercase" etc. is a style, rawText keeps the
    // typed case). Transformed per range so title case sees whole words.
    let mut shown = raw.clone();
    if ranges
        .iter()
        .any(|r| truthy(&r.s["textTransform"]) && r.s["textTransform"] != "none")
    {
        let mut cased = JsStr::default();
        for r in &ranges {
            cased.push(&apply_case(&raw.slice(r.from, r.to), &r.s["textTransform"]));
        }
        cased.push(&raw.slice(pos, raw_len));
        if cased.len() == raw.len() {
            shown = cased; // some case maps change length (ß → SS)
        }
    }
    (ranges, shown)
}

/// The text a layer shows (XD's case styles applied).
pub fn shown_text(node: &Value) -> String {
    text_runs(node).1.to_string()
}

pub fn render_text(ctx: &mut Ctx, node: &Value) -> String {
    let t = &node["text"];
    let raw_str = t["rawText"].as_str().unwrap_or("");
    let raw = JsStr::new(raw_str);
    let style = &node["style"];
    let attrs = node_attrs(ctx, node);
    let base = font_attrs_of(&style["font"]) + &paint_attrs(ctx, style, true);
    let font_size = num(&style["font"]["size"], 16.0);
    let ls = num(&style["textAttributes"]["letterSpacing"], 0.0);
    let spacing = if ls != 0.0 {
        format!(r#" letter-spacing="{}""#, fmt((ls / 1000.0) * font_size))
    } else {
        String::new()
    };

    let (ranges, shown) = text_runs(node);
    let case_at = |i: f64| {
        ranges
            .iter()
            .find(|r| i >= r.from && i < r.to)
            .map_or(&js::NULL, |r| &r.s["textTransform"])
    };
    let slice = |from: f64, to: f64| -> String {
        if shown != raw || ranges.is_empty() {
            shown.slice(from, to).to_string()
        } else {
            apply_case(&raw.slice(from, to), case_at(from)).to_string()
        }
    };

    let range_attrs = |s: &Value| {
        let mut a = font_attrs(Some(FontSpec {
            family: &s["fontFamily"],
            size: &s["fontSize"],
            style: &s["fontStyle"],
            postscript_name: &s["postscriptName"],
        }));
        a += &fill_attr(color(&s["fill"]));
        let cs = num(&s["charSpacing"], 0.0);
        if cs != ls {
            a += &format!(
                r#" letter-spacing="{}""#,
                fmt((cs / 1000.0) * num(&s["fontSize"], font_size))
            );
        }
        let deco: Vec<&str> = [
            (truthy(&s["underline"]), "underline"),
            (truthy(&s["strikethrough"]), "line-through"),
        ]
        .into_iter()
        .filter_map(|(on, d)| on.then_some(d))
        .collect();
        if !deco.is_empty() {
            a += &format!(r#" text-decoration="{}""#, deco.join(" "));
        }
        a
    };

    let segment = |from: f64, to: f64| -> String {
        if ranges.len() <= 1 {
            return esc(&slice(from, to));
        }
        ranges
            .iter()
            .filter(|r| r.to > from && r.from < to)
            .map(|r| {
                format!(
                    "<tspan{}>{}</tspan>",
                    range_attrs(r.s),
                    esc(&slice(from.max(r.from), to.min(r.to)))
                )
            })
            .collect()
    };

    // Segments can override the node style (e.g. a bold first line).
    let seg_attrs = |seg: &Value| -> String {
        if !truthy(&seg["style"]) {
            return String::new();
        }
        font_attrs_of(&seg["style"]["font"]) + &fill_attr(color(&seg["style"]["fill"]["color"]))
    };

    let mut body = String::new();
    let mut anchor = "";
    let paragraphs = t["paragraphs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if !paragraphs.is_empty() {
        let lines: Vec<&[Value]> = paragraphs
            .iter()
            .flat_map(|p| p["lines"].as_array().map(Vec::as_slice).unwrap_or(&[]))
            .map(|l| l.as_array().map(Vec::as_slice).unwrap_or(&[]))
            .collect();
        let align = &style["textAttributes"]["paragraphAlign"];
        let xs: Vec<f64> = lines
            .iter()
            .flat_map(|l| l.iter().map(|seg| num(&seg["x"], 0.0)))
            .collect();
        let ax = text_anchor_x(t, align, &xs);
        if ax.is_some() {
            anchor = if *align == "center" {
                r#" text-anchor="middle""#
            } else {
                r#" text-anchor="end""#
            };
        }
        for line in lines {
            let mut segs: Vec<(&Value, f64, f64)> = line
                .iter()
                .map(|seg| {
                    (
                        seg,
                        num(&seg["from"], 0.0),
                        num(&seg["to"], raw.len() as f64),
                    )
                })
                .filter(|(_, from, to)| to > from)
                .collect();
            if segs.is_empty() {
                continue;
            }
            let Some(ax) = ax else {
                for (seg, from, to) in &segs {
                    body += &format!(
                        r#"<tspan x="{}" y="{}"{}>{}</tspan>"#,
                        fmt(num(&seg["x"], 0.0)),
                        fmt(num(&seg["y"], 0.0)),
                        seg_attrs(seg),
                        segment(*from, *to)
                    );
                }
                continue;
            };
            // Anchored line: trailing spaces would shift it off-center.
            let last = segs.last_mut().unwrap();
            while last.2 > last.1 && raw.at(last.2 - 1.0).is_some_and(js::is_space) {
                last.2 -= 1.0;
            }
            let inner: String = segs
                .iter()
                .filter(|(_, from, to)| to > from)
                .map(|(seg, from, to)| {
                    let a = seg_attrs(seg);
                    if a.is_empty() {
                        segment(*from, *to)
                    } else {
                        format!("<tspan{a}>{}</tspan>", segment(*from, *to))
                    }
                })
                .collect();
            body += &format!(
                r#"<tspan x="{}" y="{}">{inner}</tspan>"#,
                fmt(ax),
                fmt(num(&segs[0].0["y"], 0.0))
            );
        }
    } else if !raw_str.is_empty() {
        // No layout info: fall back to one line per hard break.
        let lh = num(&style["textAttributes"]["lineHeight"], font_size * 1.2);
        let text = shown.to_string();
        let lines = text.split("\r\n").flat_map(|l| l.split(['\r', '\n']));
        for (i, l) in lines.enumerate() {
            body += &format!(
                r#"<tspan x="0" y="{}">{}</tspan>"#,
                fmt(i as f64 * lh),
                esc(l)
            );
        }
    }
    if body.is_empty() {
        return String::new();
    }
    format!(r#"<g{attrs}><text xml:space="preserve"{base}{spacing}{anchor}>{body}</text></g>"#)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights() {
        assert_eq!(weight("Inter Bold "), Some(700));
        assert_eq!(weight("Inter ExtraBold "), Some(800));
        assert_eq!(weight("Inter Semi Bold "), Some(600));
        assert_eq!(weight("Inter Extra Light"), Some(200));
        assert_eq!(weight("Inter Regular"), None);
    }

    #[test]
    fn title_case() {
        let s = apply_case(&JsStr::new("hello  wide world"), &Value::from("titlecase"));
        assert_eq!(s.to_string(), "Hello  Wide World");
    }
}
