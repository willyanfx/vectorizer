//! The Rust renderer must match the TypeScript one byte for byte.
//! Fixtures and expected output come from packages/xd (`npm run golden -w @vector/xd`).

use std::fs;
use std::path::PathBuf;

use indexmap::IndexMap;
use serde::Deserialize;
use xd_core::{ParseOptions, Size, XdArtboard, parse_xd};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    artboards: Vec<XdArtboard>,
    image_scale: f64,
    image_uris: IndexMap<String, String>,
    image_needs: IndexMap<String, Size>,
    preview: Option<String>,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/xd/test/fixtures")
}

/// Where two strings first differ, with some context.
fn first_diff(a: &str, b: &str) -> String {
    let i = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    let ctx = |s: &str| {
        let lo = s.floor_char_boundary(i.saturating_sub(60));
        let hi = s.ceil_char_boundary((i + 60).min(s.len()));
        s[lo..hi].to_string()
    };
    format!("at byte {i}:\n  rust: …{}…\n  ts:   …{}…", ctx(a), ctx(b))
}

#[test]
fn matches_typescript_golden_output() {
    let mut names: Vec<PathBuf> = fs::read_dir(fixtures())
        .expect("fixtures missing — run: npm run golden -w @vector/xd")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "xd"))
        .collect();
    names.sort();
    assert!(names.len() >= 3, "expected fixtures in {:?}", fixtures());

    for xd in names {
        let name = xd.file_stem().unwrap().to_string_lossy().to_string();
        let golden: Golden = serde_json::from_str(
            &fs::read_to_string(xd.with_file_name(format!("{name}.expected.json"))).unwrap(),
        )
        .unwrap();
        let doc = parse_xd(fs::read(&xd).unwrap(), ParseOptions { image_scale: 0.0 }).unwrap();

        assert_eq!(
            doc.artboards.len(),
            golden.artboards.len(),
            "{name}: artboard count"
        );
        for (r, t) in doc.artboards.iter().zip(&golden.artboards) {
            let at = format!("{name} / {}", t.id);
            assert!(
                r.template == t.template,
                "{at}: template differs {}",
                first_diff(&r.template, &t.template)
            );
            assert!(
                r.svg == t.svg,
                "{at}: svg differs {}",
                first_diff(&r.svg, &t.svg)
            );
            assert_eq!(r.layers, t.layers, "{at}: layers");
            assert_eq!(r, t, "{at}");
        }
        assert_eq!(doc.image_scale, golden.image_scale, "{name}: imageScale");
        assert_eq!(doc.image_uris, golden.image_uris, "{name}: imageUris");
        assert_eq!(doc.image_needs, golden.image_needs, "{name}: imageNeeds");
        assert_eq!(
            doc.preview.map(|p| p.mime.to_string()),
            golden.preview,
            "{name}: preview"
        );
    }
}
