import { describe, expect, it } from 'vitest';
import { ANDROID_PLATFORM, WINDOWS_PLATFORM, assertManifest, buildManifest } from './release-manifest.mjs';

/**
 * Guards the one invariant that took down every desktop update check in v2.6.1.
 *
 * `tauri-plugin-updater` 2.13.1 deserializes `platforms` into
 * `HashMap<String, { url: Url, signature: String }>`: `signature` has no `#[serde(default)]`,
 * so a single entry without it fails the WHOLE manifest - not just that platform:
 *
 *     检查更新失败 ✗  missing field `signature`
 *
 * The Android entry shipped without a signature on the assumption that only Android reads it.
 * It does read it, but the desktop parses all of it, and the desktop is the one that broke.
 * These tests pin "every platform entry carries a real signature" so that cannot recur.
 */

const WINDOWS_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK';
const ANDROID_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKandyb2lk';

function twoPlatformInput(overrides = {}) {
  return {
    version: '2.6.1',
    notes: 'notes',
    pubDate: '2026-10-20T00:00:00.000Z',
    platforms: [
      {
        platform: WINDOWS_PLATFORM,
        url: 'https://raw.githubusercontent.com/o/r/release-assets/MarkdownX_2.6.1_x64-setup.exe',
        signature: WINDOWS_SIG
      },
      {
        platform: ANDROID_PLATFORM,
        url: 'https://raw.githubusercontent.com/o/r/release-assets/MarkdownX_2.6.1_universal-release.apk',
        signature: ANDROID_SIG
      }
    ],
    ...overrides
  };
}

describe('update manifest construction', () => {
  it('emits both platforms with the exact signature each was signed with', () => {
    const manifest = buildManifest(twoPlatformInput());

    expect(manifest.version).toBe('2.6.1');
    expect(Object.keys(manifest.platforms).sort()).toEqual([ANDROID_PLATFORM, WINDOWS_PLATFORM].sort());
    expect(manifest.platforms[WINDOWS_PLATFORM].signature).toBe(WINDOWS_SIG);
    expect(manifest.platforms[ANDROID_PLATFORM].signature).toBe(ANDROID_SIG);
  });

  it('would have rejected the v2.6.1 manifest that broke every desktop update check', () => {
    // The historical shape: the Android entry carried a url and nothing else.
    const input = twoPlatformInput();
    delete input.platforms[1].signature;

    expect(() => buildManifest(input)).toThrow(/platforms\["android-universal"\]\.signature/);
  });

  it('treats an empty or whitespace signature as missing', () => {
    for (const bad of ['', '   ', null, undefined]) {
      const input = twoPlatformInput();
      input.platforms[1].signature = bad;
      expect(() => buildManifest(input), `signature=${JSON.stringify(bad)}`).toThrow(/signature/);
    }
  });

  it('requires at least one platform and rejects duplicates', () => {
    expect(() => buildManifest(twoPlatformInput({ platforms: [] }))).toThrow(/至少一个平台/);
    const dup = twoPlatformInput();
    dup.platforms[1].platform = WINDOWS_PLATFORM;
    expect(() => buildManifest(dup)).toThrow(/重复/);
  });

  it('rejects a non-https download url', () => {
    const input = twoPlatformInput();
    input.platforms[0].url = 'http://example.com/setup.exe';
    expect(() => buildManifest(input)).toThrow(/https/);
  });

  it('survives a JSON round trip with both signatures intact', () => {
    // What actually ships: latest.json is serialised, fetched, and parsed by a Rust
    // deserializer that will reject the whole document if one key went missing.
    const parsed = JSON.parse(JSON.stringify(buildManifest(twoPlatformInput())));

    for (const [key, entry] of Object.entries(parsed.platforms)) {
      expect(typeof entry.url, `${key}.url`).toBe('string');
      expect(typeof entry.signature, `${key}.signature`).toBe('string');
      expect(entry.signature, `${key}.signature`).not.toBe('');
    }
    expect(() => assertManifest(parsed)).not.toThrow();
  });
});

describe('manifest validation of already-built documents', () => {
  it('accepts a well-formed manifest', () => {
    const manifest = buildManifest(twoPlatformInput());
    expect(assertManifest(manifest)).toBe(manifest);
  });

  it('rejects a manifest whose platforms is missing or empty', () => {
    expect(() => assertManifest({ version: '1.0.0', notes: '', pub_date: '2026-01-01T00:00:00Z' }))
      .toThrow(/platforms/);
    expect(() =>
      assertManifest({ version: '1.0.0', notes: '', pub_date: '2026-01-01T00:00:00Z', platforms: {} })
    ).toThrow(/至少需要一个平台条目/);
  });

  it('rejects a bad pub_date instead of emitting one the updater cannot parse', () => {
    expect(() => buildManifest(twoPlatformInput({ pubDate: 'not-a-date' }))).toThrow(/pub_date/);
  });

  it('rejects an empty version', () => {
    expect(() => buildManifest(twoPlatformInput({ version: '  ' }))).toThrow(/version/);
  });
});
