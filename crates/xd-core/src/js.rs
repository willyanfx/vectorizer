//! JavaScript semantics the TypeScript renderer relies on, so the Rust port
//! produces byte-identical SVG: number formatting, `Math.round`, truthiness,
//! `??`, `String(v)`, and UTF-16 string indexing (XD stores text ranges in
//! UTF-16 code units, like JS strings).

use serde_json::Value;

pub static NULL: Value = Value::Null;

/// `n(v, d)`: the value if it is a finite number, else `d`.
pub fn num(v: &Value, d: f64) -> f64 {
    match v.as_f64() {
        Some(x) if x.is_finite() => x,
        _ => d,
    }
}

/// JS truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a ?? b`.
pub fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if a.is_null() { b } else { a }
}

/// `a || b`.
pub fn or_truthy<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if truthy(a) { a } else { b }
}

/// `v[key]` where key is any JS value (property keys are strings).
pub fn get<'a>(v: &'a Value, key: &Value) -> &'a Value {
    match v {
        Value::Object(m) => m.get(&string(key)).unwrap_or(&NULL),
        _ => &NULL,
    }
}

/// `String(v)`.
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `${v ?? ''}`.
pub fn string_or_empty(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        string(v)
    }
}

/// `Number(v)` (what arithmetic does to a non-number).
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as u8 as f64,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = trim(s);
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Array(_) | Value::Object(_) => to_number(&Value::String(string(v))),
    }
}

/// `String(x)` for a number.
pub fn number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{x}");
    }
    // JS switches to exponent form outside [1e-6, 1e21): 1e+21, 1.5e-7.
    let s = format!("{x:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// `Math.round`: nearest integer, ties toward +∞.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `fmt(v)`: three decimals, shortest form.
pub fn fmt(v: f64) -> String {
    number(round(v * 1000.0) / 1000.0)
}

/// `Math.max(a, b)` (NaN-propagating, unlike `f64::max`).
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)` (NaN-propagating).
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// JS `\s` for one UTF-16 code unit.
pub fn is_space(u: u16) -> bool {
    matches!(
        u,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

pub fn is_space_char(c: char) -> bool {
    (c as u32) < 0x10000 && is_space(c as u16)
}

/// A JS string: UTF-16 code units.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct JsStr(pub Vec<u16>);

impl JsStr {
    pub fn new(s: &str) -> Self {
        JsStr(s.encode_utf16().collect())
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `String.prototype.slice(from, to)`.
    pub fn slice(&self, from: f64, to: f64) -> JsStr {
        let len = self.0.len() as f64;
        let clamp = |i: f64| -> usize {
            let i = if i.is_nan() { 0.0 } else { i.trunc() };
            let i = if i < 0.0 {
                (len + i).max(0.0)
            } else {
                i.min(len)
            };
            i as usize
        };
        let (a, b) = (clamp(from), clamp(to));
        JsStr(if a < b {
            self.0[a..b].to_vec()
        } else {
            Vec::new()
        })
    }

    /// `s[i]` as a code unit (None for out-of-range or fractional indices).
    pub fn at(&self, i: f64) -> Option<u16> {
        if i.fract() != 0.0 || i < 0.0 {
            return None;
        }
        self.0.get(i as usize).copied()
    }

    pub fn push(&mut self, other: &JsStr) {
        self.0.extend_from_slice(&other.0);
    }
}

impl std::fmt::Display for JsStr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&String::from_utf16_lossy(&self.0))
    }
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space_char)
}

/// `s.replace(/\s+/g, ' ')`.
pub fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space_char(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(number(375.0), "375");
        assert_eq!(number(0.1), "0.1");
        assert_eq!(number(-0.0), "0");
        assert_eq!(number(1e21), "1e+21");
        assert_eq!(number(1.5e-7), "1.5e-7");
        assert_eq!(number(0.000001), "0.000001");
        assert_eq!(number(f64::INFINITY), "Infinity");
        assert_eq!(fmt(1.23456), "1.235");
        assert_eq!(fmt(-0.0004), "0");
        assert_eq!(fmt(f64::NAN), "NaN");
    }

    #[test]
    fn rounding_ties_go_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-2.6), -3.0);
    }

    #[test]
    fn slices_by_utf16() {
        let s = JsStr::new("a😀b");
        assert_eq!(s.len(), 4);
        assert_eq!(s.slice(1.0, 3.0).to_string(), "😀");
        assert_eq!(s.slice(-1.0, 10.0).to_string(), "b");
        assert_eq!(s.slice(3.0, 1.0).to_string(), "");
    }
}
