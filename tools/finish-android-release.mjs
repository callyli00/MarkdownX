#!/usr/bin/env node
/**
 * Finish the Android half of a release that is ALREADY published.
 *
 * Why this exists: on 2026-10-25 the 23.6 MB APK could not be uploaded from this machine at
 * all — curl / gh / node-fetch all stalled mid-body (the 13.4 MB installer goes through, the
 * APK never does; the APK's `.so` must stay uncompressed because the manifest sets
 * `extractNativeLibs=false`, so it cannot be shrunk by compressing it; stripping the library
 * only gets it to ~19 MB). The release therefore shipped with a windows-only manifest.
 *
 * Once the APK exists as a release asset — uploaded from a browser, another machine, or a
 * retry on a healthier link — this script re-adds the android entry and republishes the
 * manifest. It touches only two small things: the `latest.json` asset (6 KB) and one commit
 * on the `release-assets` branch (6 KB). It never re-uploads the binaries.
 *
 *   node tools/finish-android-release.mjs [--version 2.7.0] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = 'callyli00';
const REPO = 'MarkDownX';
const BRANCH = 'release-assets';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const version = arg('version', JSON.parse(readFileSync('package.json', 'utf8')).version);
const dryRun = args.includes('--dry-run');
const tag = `v${version}`;
const bundle = 'src-tauri/target/release/bundle';
const apkName = `MarkdownX_${version}_universal-release.apk`;
const installerName = `MarkdownX_${version}_x64-setup.exe`;

const gh = (...argv) => execFileSync('gh', argv, { encoding: 'utf8' }).trim();

function assetNames(releaseTag) {
  return JSON.parse(gh('release', 'view', releaseTag, '--json', 'assets')).assets.map((a) => a.name);
}

// 1. Refuse to build a manifest that points at an asset nobody can download.
const assets = assetNames(tag);
if (!assets.includes(apkName)) {
  console.error(`✗ Release ${tag} 里没有 ${apkName}`);
  console.error(`  先把 APK 传上去：gh release upload ${tag} ${join(bundle, apkName)} --clobber`);
  console.error('  （或直接在 Release 页面把文件拖进 Assets）');
  process.exit(2);
}
if (!assets.includes(installerName)) {
  console.error(`✗ Release ${tag} 里没有 ${installerName}`);
  process.exit(2);
}

// 2. Rebuild the manifest: both platforms, every URL on the release (see MAINTENANCE §13.14
//    for why the raw branch carries only the manifest on this network).
const manifestPath = join(bundle, 'latest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const base = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/`;
const readSig = (file) => {
  const sigPath = join(bundle, `${file}.sig`);
  if (!existsSync(sigPath)) throw new Error(`缺少签名文件 ${sigPath}（没有它客户端会拒绝安装）`);
  return readFileSync(sigPath, 'utf8').trim();
};

manifest.version = version;
manifest.platforms = {
  'windows-x86_64': { url: base + installerName, signature: readSig(installerName) },
  'android-universal': { url: base + apkName, signature: readSig(apkName) }
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ 清单已重建：${Object.keys(manifest.platforms).join(', ')}`);

if (dryRun) {
  console.log('（--dry-run：不上传、不推送）');
  process.exit(0);
}

// 3. Replace the manifest asset (6 KB, instant) …
gh('release', 'upload', tag, manifestPath, '--clobber');
console.log(`✓ 已覆盖 Release 的 latest.json`);

// 4. … and the raw branch, which is the endpoint clients try first.
const staging = mkdtempSync(join(tmpdir(), 'mdx-assets-'));
const copy = join(staging, 'latest.json');
writeFileSync(copy, readFileSync(manifestPath));
const git = (...argv) => execFileSync('git', ['-c', 'safe.directory=*', ...argv], { cwd: staging, encoding: 'utf8' });
git('init', '-q');
git('checkout', '-q', '-b', BRANCH);
git('add', 'latest.json');
git('-c', 'user.name=MarkdownX Maintainer', '-c', 'user.email=maintainer@markdownx.local',
  'commit', '-q', '-m', `release ${tag}: latest.json (binaries on the GitHub Release)`);
const token = gh('auth', 'token');
execFileSync('git', ['-c', 'safe.directory=*', '-c', 'http.version=HTTP/1.1', 'push', '-f', '--quiet',
  `https://x-access-token:${token}@github.com/${OWNER}/${REPO}.git`, `HEAD:${BRANCH}`], { cwd: staging });
console.log(`✓ ${BRANCH} 分支已更新`);

// 5. Report the three endpoints the clients use.
const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/latest.json`;
const fallback = `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.json`;
for (const url of [raw, fallback]) {
  const body = execFileSync('curl', ['-s', '-m', '20', url], { encoding: 'utf8' });
  let reported = '?';
  try { reported = JSON.parse(body).version; } catch { reported = '(unparsable)'; }
  console.log(`  ${reported === version ? '✓' : '✗'} ${url} → ${reported}`);
}
console.log('\nAndroid 端现在也能收到更新了。');
