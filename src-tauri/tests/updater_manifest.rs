//! Regression test for the v2.6.1 desktop updater outage.
//!
//! ```text
//! 检查更新失败 ✗  missing field `signature`
//! ```
//!
//! The v2.6.1 manifest added an `android-universal` entry without a `signature`, reasoning that
//! only the Android side reads that entry and the APK is not minisign-signed. Both halves of
//! that reasoning missed how the desktop reads the file: `tauri-plugin-updater` deserializes
//! `platforms` into `HashMap<String, ReleaseManifestPlatform>` where
//! `ReleaseManifestPlatform { url: Url, signature: String }` has no `#[serde(default)]` on
//! `signature`. Deserializing a map materialises EVERY value, so one signature-less entry made
//! the whole response unparseable - the network was fine, the endpoint returned `200`, and the
//! desktop still could not read it.
//!
//! These tests use the real plugin types rather than a mirror of them, so a future plugin
//! release that changes the requirement fails here instead of in the field.
//!
//! Desktop-only: `tauri-plugin-updater` is a dependency of the desktop targets only
//! (`src-tauri/Cargo.toml`), so this file compiles to nothing on Android.

#![cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]

use tauri_plugin_updater::RemoteRelease;

const WINDOWS_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTUW11NElLelc2SHU5Rk90eFZjdDJTN3NRdGFoZFdPczVXT3V3WU5KM0RxVkpSNEhJTnhnUTE3NWl5QXlEOUVMS1MvYmw5TFlUcE1sd1NMTkR2NGQ3eTR2VHlvTTQwWmdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNDc1ODI4CWZpbGU6TWFya2Rvd25YXzIuNi4xX3g2NC1zZXR1cC5leGUJdmVyc2lvbjoyLjYuMQpzWFA0SlFaZy9TQ1hwRzc2ZjJsZ2dhZlBXdEZBUUVQWDVBT0lxTE9RQjlhSFZtMjkvRGpIekNBZFpHZWFGeUhzZCs3OHlEYU8wSDZicVlweWk2U2ZDQT09Cg==";
const ANDROID_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTUW11NElLelc2SHZORm5LeG5WOWsxViswTmMvajZkTXJLZzVEckN5a3Rjc1d4bnZPZEZBa1NkWmxzU2xuSXdIaitOU1VGbWtiV1k5UG9oRHhlQjZyVjFHWUlES1k4Y2dzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNDg1MjEzCWZpbGU6TWFya2Rvd25YXzIuNi4xX3VuaXZlcnNhbC1yZWxlYXNlLmFwawl2ZXJzaW9uOjIuNi4xCnI1TTljWVoyaXQ3ZTJYTXhuejFXakpKTk93MlNkOVRvSEhSNWxkRXVDYXBFT1dsa2x0a21NZFJqeHlLVVRObFdRNEx1VWdLaEVOYmVibk5XM0s1Y0J3PT0K";

fn manifest_json(android_signature: Option<&str>) -> String {
    let android = match android_signature {
        Some(sig) => format!(
            r#""android-universal": {{ "url": "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/MarkdownX_2.6.1_universal-release.apk", "signature": "{sig}" }}"#
        ),
        None => r#""android-universal": { "url": "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/MarkdownX_2.6.1_universal-release.apk" }"#.to_string(),
    };

    format!(
        r#"{{
  "version": "2.6.1",
  "notes": "notes",
  "pub_date": "2026-10-20T00:00:00Z",
  "platforms": {{
    "windows-x86_64": {{ "url": "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/MarkdownX_2.6.1_x64-setup.exe", "signature": "{WINDOWS_SIG}" }},
    {android}
  }}
}}"#
    )
}

#[test]
fn two_platform_manifest_deserializes_and_exposes_both_signatures() {
    let release: RemoteRelease =
        serde_json::from_str(&manifest_json(Some(ANDROID_SIG))).expect("manifest must deserialize");

    assert_eq!(release.version.to_string(), "2.6.1");

    // The desktop lookup: `get_urls` tries `{os}-{arch}-{installer}` then `{os}-{arch}`.
    assert_eq!(
        release.download_url("windows-x86_64").unwrap().as_str(),
        "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/MarkdownX_2.6.1_x64-setup.exe"
    );
    assert_eq!(release.signature("windows-x86_64").unwrap(), WINDOWS_SIG);

    // The Android entry is readable even though the desktop never installs it.
    assert_eq!(release.signature("android-universal").unwrap(), ANDROID_SIG);
    assert!(release
        .download_url("android-universal")
        .unwrap()
        .as_str()
        .ends_with("MarkdownX_2.6.1_universal-release.apk"));
}

#[test]
fn signature_less_android_entry_fails_the_whole_manifest() {
    // This is exactly what v2.6.1 shipped, and exactly what the user saw. Kept as a test so the
    // "Android does not need a signature" assumption cannot be reintroduced silently: the failure
    // is not scoped to the Android entry, it destroys desktop parsing too.
    let err = serde_json::from_str::<RemoteRelease>(&manifest_json(None))
        .expect_err("a platforms entry without a signature must not deserialize");

    let message = err.to_string();
    assert!(
        message.contains("signature"),
        "unexpected error, expected it to mention `signature`: {message}"
    );
}

#[test]
fn a_manifest_without_the_android_entry_still_works() {
    // The pre-2.6.1 shape: a Windows-only release must keep working, so the fix for the
    // regression cannot depend on the Android entry existing at all.
    let json = format!(
        r#"{{
  "version": "2.6.1",
  "notes": "notes",
  "pub_date": "2026-10-20T00:00:00Z",
  "platforms": {{
    "windows-x86_64": {{ "url": "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/MarkdownX_2.6.1_x64-setup.exe", "signature": "{WINDOWS_SIG}" }}
  }}
}}"#
    );

    let release: RemoteRelease = serde_json::from_str(&json).expect("manifest must deserialize");
    assert_eq!(release.version.to_string(), "2.6.1");
    assert_eq!(release.signature("windows-x86_64").unwrap(), WINDOWS_SIG);
}
