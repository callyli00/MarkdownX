//! Reading the update manifest for Android, and deciding whether it is newer.
//!
//! Why this is a separate, cfg-free module: the network half of the Android updater has to
//! live in Kotlin (the mobile Rust build carries no HTTP client), so what remains on the
//! Rust side is everything that can actually be *wrong* - reading the manifest and
//! answering "is this newer than what I am running". Keeping it free of
//! `cfg(target_os = "android")` means `cargo test` on the host covers it, which is the only
//! automated check this feature can get without a phone on the desk.
//!
//! The manifest is the SAME `latest.json` the desktop updater consumes. Android's APK is an
//! extra entry under `platforms`, so one file describes a release for both platforms and the
//! two can never disagree about the version number:
//!
//! ```json
//! {
//!   "version": "2.6.1",
//!   "notes": "…",
//!   "platforms": {
//!     "windows-x86_64": { "signature": "…", "url": "…setup.exe" },
//!     "android-universal": { "url": "…universal-release.apk" }
//!   }
//! }
//! ```
//!
//! Only the Android commands in `lib.rs` use these items, but the module is compiled on every
//! target so `cargo test` (which runs on the host) covers it. Hence the dead-code allowance
//! everywhere else - the alternative would be `cfg`-gating the module and losing the tests.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

/// Key under `platforms` that carries the APK. One universal APK holds every ABI, so there
/// is exactly one Android asset per release rather than a per-ABI family the manifest would
/// have to keep in sync.
pub const ANDROID_PLATFORM_KEY: &str = "android-universal";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidRelease {
    /// Version from the manifest, with a leading `v` stripped ("2.6.1").
    pub version: String,
    /// Release notes verbatim; empty when the manifest has none.
    pub notes: String,
    /// Absolute http(s) URL of the APK.
    pub url: String,
}

/// Parse an updater manifest into the Android-relevant parts.
///
/// Errors are the user-facing reason strings the update dialog shows, so they name the
/// concrete problem instead of "failed to parse".
pub fn parse_manifest(json: &str) -> Result<AndroidRelease, String> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("更新清单不是合法 JSON：{e}"))?;

    let version = root
        .get("version")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().trim_start_matches('v').to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "更新清单缺少 version 字段".to_string())?;

    let notes = root
        .get("notes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let asset = root
        .get("platforms")
        .and_then(|p| p.get(ANDROID_PLATFORM_KEY))
        .ok_or_else(|| format!("更新清单里没有 {ANDROID_PLATFORM_KEY} 条目：这次发布没有上传 APK"))?;

    let url = asset
        .get("url")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{ANDROID_PLATFORM_KEY} 条目缺少 url"))?;

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("APK 地址不是 http(s) 链接：{url}"));
    }

    Ok(AndroidRelease {
        version,
        notes,
        url,
    })
}

/// Numeric, dot-separated comparison: `2.10.0` is NEWER than `2.9.9`, which a plain string
/// comparison gets backwards. Missing components count as zero (`2.6` == `2.6.0`), and a
/// leading `v` is ignored.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = numeric_parts(a);
    let pb = numeric_parts(b);
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// True when `candidate` should be offered to someone running `current`.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) == std::cmp::Ordering::Greater
}

/// Leading run of plain numeric components.
///
/// Stops at the first component that is not a bare number, so a pre-release tag
/// (`2.7.0-beta.1`) compares as `2.7.0` instead of silently beating the stable `2.7.0`, and
/// a garbage version compares as "no components" (i.e. equal to everything, never newer).
fn numeric_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .map_while(|c| c.parse::<u64>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(platforms: &str) -> String {
        format!(r#"{{"version":"2.6.1","notes":"n","platforms":{platforms}}}"#)
    }

    #[test]
    fn reads_version_notes_and_apk_url() {
        let release = parse_manifest(&manifest(
            r#"{"windows-x86_64":{"url":"https://x/a.exe"},"android-universal":{"url":"https://x/a.apk"}}"#,
        ))
        .expect("manifest should parse");
        assert_eq!(release.version, "2.6.1");
        assert_eq!(release.notes, "n");
        assert_eq!(release.url, "https://x/a.apk");
    }

    #[test]
    fn strips_a_leading_v_from_the_version() {
        let json = r#"{"version":"v2.6.1","platforms":{"android-universal":{"url":"https://x/a.apk"}}}"#;
        assert_eq!(parse_manifest(json).unwrap().version, "2.6.1");
    }

    #[test]
    fn a_release_without_an_apk_says_so() {
        let err = parse_manifest(&manifest(
            r#"{"windows-x86_64":{"url":"https://x/a.exe"}}"#,
        ))
        .unwrap_err();
        assert!(err.contains(ANDROID_PLATFORM_KEY), "unexpected error: {err}");
    }

    #[test]
    fn rejects_non_json_and_non_http_urls() {
        assert!(parse_manifest("<html>404</html>").is_err());
        let err = parse_manifest(&manifest(
            r#"{"android-universal":{"url":"file:///data/local/tmp/a.apk"}}"#,
        ))
        .unwrap_err();
        assert!(err.contains("http"), "unexpected error: {err}");
    }

    #[test]
    fn compares_numerically_not_lexicographically() {
        assert!(is_newer("2.10.0", "2.9.9"));
        assert!(is_newer("2.6.1", "2.6.0"));
        assert!(!is_newer("2.6.0", "2.6.0"));
        assert!(!is_newer("2.5.9", "2.6.0"));
        // Missing components are zeros, and a leading v is not part of the number.
        assert!(!is_newer("2.6", "2.6.0"));
        assert!(is_newer("v2.7", "2.6.9"));
    }

    #[test]
    fn a_prerelease_does_not_displace_the_stable_build() {
        assert!(!is_newer("2.7.0-beta.1", "2.7.0"));
        assert!(is_newer("2.7.0-beta.1", "2.6.9"));
    }

    #[test]
    fn an_unparseable_version_is_never_newer() {
        assert!(!is_newer("nightly", "2.6.0"));
        assert!(!is_newer("", "2.6.0"));
    }
}
