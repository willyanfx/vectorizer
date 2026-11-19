//! Embedded images: placeholders in the SVG, filled with (downscaled) data URIs.
//! Port of packages/xd/src/images.ts.

use base64::Engine as _;
use indexmap::IndexMap;

use crate::js;
use crate::model::Size;

pub fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    match (b.first(), b.get(1)) {
        (Some(0x89), Some(0x50)) => Some("image/png"),
        (Some(0xff), Some(0xd8)) => Some("image/jpeg"),
        (Some(0x47), Some(0x49)) => Some("image/gif"),
        (Some(0x52), Some(0x49)) if b.get(8) == Some(&0x57) => Some("image/webp"),
        (Some(0x3c), _) => Some("image/svg+xml"), // '<'
        _ => None,
    }
}

fn data_uri(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// 1×1 transparent PNG: keeps <image> boxes clickable without the image data.
pub const BLANK_IMAGE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const TOKEN: &str = "__XDIMG_";

fn is_key_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')
}

/// Replace image placeholders with data URIs (missing → ''), or with
/// [`BLANK_IMAGE`] when `uris` is None. Same matches as
/// `/__XDIMG_([\w.-]+)__/g`.
pub fn fill_images(template: &str, uris: Option<&IndexMap<String, String>>) -> String {
    let b = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(i) = template[from..].find(TOKEN).map(|i| i + from) {
        let start = i + TOKEN.len();
        let mut run = start;
        while run < b.len() && is_key_char(b[run]) {
            run += 1;
        }
        // Greedy `[\w.-]+` backs off to the last `__` inside the run.
        let key_end = (start + 1..run.saturating_sub(1))
            .rev()
            .find(|&k| &b[k..k + 2] == b"__");
        let Some(key_end) = key_end else {
            from = i + 1;
            continue;
        };
        let key = &template[start..key_end];
        out.push_str(&template[copied..i]);
        match uris {
            None => out.push_str(BLANK_IMAGE),
            Some(u) => out.push_str(u.get(key).map_or("", String::as_str)),
        }
        copied = key_end + 2;
        from = copied;
    }
    out.push_str(&template[copied..]);
    out
}

/// Data URI for an embedded image, downscaled so it still covers its largest
/// on-artboard box at `scale`× (never upscaled). Opaque images become JPEG,
/// images with transparency stay PNG. `scale` 0 keeps the original.
pub fn image_data_uri(bytes: Option<&[u8]>, size: Size, scale: f64) -> Option<String> {
    let bytes = bytes?;
    let mime = sniff_mime(bytes).filter(|m| *m != "image/svg+xml")?;
    let original = || data_uri(mime, bytes);
    if scale == 0.0 || scale.is_nan() {
        return Some(original());
    }
    Some(downscale(bytes, mime, size, scale).unwrap_or_else(original))
}

fn downscale(bytes: &[u8], mime: &str, size: Size, scale: f64) -> Option<String> {
    use image::{DynamicImage, ImageEncoder, codecs::jpeg::JpegEncoder, codecs::png::PngEncoder};

    let img = image::load_from_memory(bytes).ok()?;
    let (iw, ih) = (img.width() as f64, img.height() as f64);
    // "cover" fit: the image is scaled so both box dimensions are filled.
    let s = js::max(size.w / iw, size.h / ih) * scale;
    let keep_original = s.is_nan() || s <= 0.0 || s >= 0.9; // within 10%: not worth re-encoding
    if keep_original && (mime == "image/png" || mime == "image/jpeg") {
        return None;
    }
    let f = if s == 0.0 || s.is_nan() { 1.0 } else { s }.min(1.0);
    let w = js::round(iw * f).max(1.0) as u32;
    let h = js::round(ih * f).max(1.0) as u32;
    let rgba = img.to_rgba8();
    let small = image::imageops::thumbnail(&rgba, w, h);
    let opaque = small.pixels().all(|p| p.0[3] == 255);

    let mut out = Vec::new();
    let out_mime = if opaque {
        let rgb = DynamicImage::ImageRgba8(small).to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 88)
            .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .ok()?;
        "image/jpeg"
    } else {
        PngEncoder::new(&mut out)
            .write_image(small.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .ok()?;
        "image/png"
    };
    (out.len() < bytes.len()).then(|| data_uri(out_mime, &out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_placeholders_like_the_js_regex() {
        let uris: IndexMap<String, String> = [("a_b".to_string(), "U".to_string())].into();
        assert_eq!(
            fill_images(r#"<image href="__XDIMG_a_b__"/>"#, Some(&uris)),
            r#"<image href="U"/>"#
        );
        assert_eq!(fill_images("x__XDIMG_zz__y", Some(&uris)), "xy");
        assert_eq!(
            fill_images("__XDIMG___ __XDIMG_a_b__", Some(&uris)),
            "__XDIMG___ U"
        );
        assert_eq!(fill_images("__XDIMG_a__", None), BLANK_IMAGE);
    }

    #[test]
    fn downscales_large_images() {
        let big = image::RgbImage::from_fn(800, 600, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(big)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let uri = image_data_uri(Some(&png), Size { w: 80.0, h: 60.0 }, 2.0).unwrap();
        assert!(uri.starts_with("data:image/jpeg;base64,"), "opaque → JPEG");
        let kept = image_data_uri(Some(&png), Size { w: 800.0, h: 600.0 }, 2.0).unwrap();
        assert!(
            kept.starts_with("data:image/png;base64,"),
            "already small enough → original"
        );
        assert_eq!(
            image_data_uri(Some(&png), Size { w: 80.0, h: 60.0 }, 0.0),
            Some(data_uri("image/png", &png))
        );
    }
}
