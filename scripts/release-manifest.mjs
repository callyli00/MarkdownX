/**
 * Build the updater manifest (`latest.json`) that both updaters read.
 *
 * Two consumers, one file
 * -----------------------
 * The desktop updater (`tauri-plugin-updater`) and the Android updater
 * (`src-tauri/src/android_update.rs`) fetch the SAME manifest, because one release must never
 * be able to advertise two different versions. They read it very differently, though:
 *
 *   - Desktop deserializes the whole `platforms` map up front into
 *     `HashMap<String, ReleaseManifestPlatform>` where the entry type is
 *     `{ url: Url, signature: String }` with NO optional/default on `signature`. So every
 *     entry of the map has to carry a signature, including entries for platforms the desktop
 *     will never install.
 *   - Android's `parse_manifest` only pulls `version`, `notes` and
 *     `platforms["android-universal"].url` out of the same JSON, and never looks at
 *     `signature` (the APK's trust anchor is the Android signing certificate: the OS refuses
 *     to install over a package signed with a different cert).
 *
 * Why that matters (v2.6.1 regression)
 * -----------------------------------
 * The Android support was added by appending an `android-universal` entry WITHOUT a signature,
 * on the reasoning that only Android reads it. That reasoning was wrong: the desktop
 * deserializer materialises every entry of the map, so one signature-less entry made the whole
 * response unreadable and the desktop app reported
 *
 *     检查更新失败 ✗  missing field `signature`
 *
 * while the raw endpoint was perfectly reachable. The fix is to minisign-sign the APK too and
 * publish a real signature for it, which this module now refuses to let anyone skip.
 */

/** Updater target string for the Windows x64 installer (`get_urls` looks up `{os}-{arch}`). */
export const WINDOWS_PLATFORM = 'windows-x86_64';

/** Updater target string the Android side hard-codes (`ANDROID_PLATFORM_KEY`). */
export const ANDROID_PLATFORM = 'android-universal';

/** URL of a release asset served from the `release-assets` branch (raw endpoint). */
export function rawAssetUrl(owner, repo, branch, assetName) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${assetName}`;
}

function requireText(label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`更新清单字段 ${label} 缺失或为空`);
  }
  return value;
}

function requireHttpsUrl(label, value) {
  requireText(label, value);
  if (!/^https:\/\/[^\s]+$/.test(value)) {
    throw new Error(`更新清单字段 ${label} 必须是 https 地址，实际为: ${value}`);
  }
  return value;
}

/**
 * Validate one `platforms[key]` entry.
 *
 * `signature` is deliberately as strict as `url`: `tauri-plugin-updater` cannot deserialize an
 * entry without it, and a failure there takes down the whole manifest rather than one platform.
 */
function assertPlatformEntry(key, entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`更新清单 platforms["${key}"] 必须是对象`);
  }
  requireHttpsUrl(`platforms["${key}"].url`, entry.url);
  requireText(`platforms["${key}"].signature`, entry.signature);
}

/**
 * Re-validate an already-built (or freshly parsed) manifest.
 *
 * Used as a last-line check right before the file is written, and by the tests. Kept separate
 * from `buildManifest` so a manifest that came from somewhere else can be checked too.
 */
export function assertManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') {
    throw new Error('更新清单必须是对象');
  }
  requireText('version', manifest.version);
  requireText('pub_date', manifest.pub_date);
  if (Number.isNaN(new Date(manifest.pub_date).getTime())) {
    throw new Error(`更新清单字段 pub_date 不是合法时间: ${manifest.pub_date}`);
  }
  if (typeof manifest.notes !== 'string') {
    throw new Error('更新清单字段 notes 必须是字符串');
  }
  const platforms = manifest.platforms;
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error('更新清单字段 platforms 必须是对象');
  }
  const keys = Object.keys(platforms);
  if (keys.length === 0) {
    throw new Error('更新清单 platforms 至少需要一个平台条目');
  }
  for (const key of keys) {
    assertPlatformEntry(key, platforms[key]);
  }
  return manifest;
}

/**
 * Assemble `latest.json`.
 *
 * `platforms` is a list (not an object) so that a typo in a target string cannot silently
 * create a second, unread entry; duplicates are rejected.
 *
 * @param {object} input
 * @param {string} input.version      e.g. `2.6.1`
 * @param {string} [input.notes]      release notes, plain text or markdown
 * @param {string} input.pubDate      RFC 3339 / ISO 8601 timestamp
 * @param {Array<{platform: string, url: string, signature: string}>} input.platforms
 * @returns {{version: string, notes: string, pub_date: string, platforms: Record<string, {url: string, signature: string}>}}
 */
export function buildManifest({ version, notes = '', pubDate, platforms }) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('buildManifest 需要至少一个平台条目（签名是必填的）');
  }

  const seen = new Set();
  const map = {};
  for (const entry of platforms) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('平台条目必须是对象');
    }
    const key = requireText('platform', entry.platform);
    if (seen.has(key)) {
      throw new Error(`平台条目重复: ${key}`);
    }
    seen.add(key);
    map[key] = { url: entry.url, signature: entry.signature };
  }

  const manifest = {
    version,
    notes,
    pub_date: pubDate,
    platforms: map
  };

  return assertManifest(manifest);
}
