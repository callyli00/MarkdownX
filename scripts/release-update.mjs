#!/usr/bin/env node
/**
 * Cut a signed release and prepare the updater manifest.
 *
 *   node scripts/release-update.mjs --owner <github-user> --repo <repo>
 *
 * What it does
 *   1. Builds the app with updater artifacts enabled, signing with the minisign key
 *      that lives OUTSIDE this repository (never commit it).
 *   2. Collects the NSIS installer plus its .sig file.
 *   3. Stages and minisign-signs the Android APK with the SAME key, then writes
 *      latest.json in the format the Tauri updater expects.
 *   4. Prints the two commands that publish it (GitHub CLI, or the manual route).
 *
 * The APK signature is not optional. `tauri-plugin-updater` deserializes every entry of the
 * `platforms` map into `{ url, signature }` with no default on `signature`, so one
 * signature-less entry (the Android one) makes the whole manifest unreadable on the desktop.
 * See scripts/release-manifest.mjs for the full story.
 *
 * Release notes come from this project's README changelog: the newest `### [vX.Y.Z]`
 * section is used verbatim, so notes live in exactly one place.
 *
 * The private key: pass its path via TAURI_SIGNING_PRIVATE_KEY_PATH, or leave it at the
 * default location used by `tauri signer generate` on this machine.
 */

import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANDROID_PLATFORM, WINDOWS_PLATFORM, buildManifest, rawAssetUrl } from './release-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_KEY = 'C:/Users/callyli00/.tauri/markdownx-updater.key';
const ASSET_BRANCH = 'release-assets';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const owner = arg('owner');
const repo = arg('repo', 'MarkdownX');
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || process.env.TAURI_SIGNING_PRIVATE_KEY || DEFAULT_KEY;

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

if (!owner) {
  console.error('用法: node scripts/release-update.mjs --owner <github-user> [--repo <repo>]');
  process.exit(2);
}
if (!existsSync(keyPath)) {
  console.error(`找不到签名私钥: ${keyPath}\n（用 npm run tauri signer generate -w <路径> 生成；它必须留在仓库之外）`);
  process.exit(2);
}

const skipBuild = process.argv.includes('--skip-build');
console.log(`→ 版本 ${version}；使用签名私钥 ${keyPath}${skipBuild ? '（--skip-build：复用已有产物）' : ''}`);

// Android APK: an explicit --apk wins; otherwise the standard Gradle output location is
// tried. The APK is normally built in the LOCAL checkout (an Android build cannot run from
// the NAS: tauri-cli panics with AssetDirOutsideOfAppRoot), so a path is often needed.
//   npx tauri android build --apk     (in the local clone)
const APK_CANDIDATES = [
  arg('apk'),
  join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'universal', 'release', 'app-universal-release.apk'),
  join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
].filter(Boolean);
const apkPath = APK_CANDIDATES.find((candidate) => existsSync(candidate)) || null;
if (!apkPath) {
  console.warn(
    '\n⚠ 没有找到 APK：本次发布不含 Android 资产，手机端「检查更新」会报“更新清单里没有 android-universal 条目”。\n' +
    '  补上：node scripts/release-update.mjs --owner ' + (owner || '<owner>') + ' --apk <apk 路径> --skip-build --publish'
  );
}

// 1. signed build (updater artifacts + .sig)
if (!skipBuild) {
  execFileSync('npm', ['run', 'tauri', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
    shell: process.platform === 'win32'
  });
} else {
  console.log('   跳过构建');
}

// 2. collect artifacts
const bundleDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
const installer = join(bundleDir, 'nsis', `MarkdownX_${version}_x64-setup.exe`);
const signatureFile = `${installer}.sig`;
if (!existsSync(installer)) throw new Error(`找不到安装包: ${installer}`);
if (!existsSync(signatureFile)) {
  throw new Error(
    `找不到签名文件 ${signatureFile}\n` +
    '说明构建没有签名：确认 bundle.createUpdaterArtifacts=true 且私钥路径正确。'
  );
}
const signature = readFileSync(signatureFile, 'utf8').trim();

/**
 * Minisign-sign one file in place and return the signature text.
 *
 * The Tauri CLI is invoked as `node <cli.js>` instead of `npx tauri`/`shell:true`: no shell
 * means no quoting of Windows paths (the repo and bundle dir live on a NAS share), and
 * `--app-version` stamps the version into the signature's trusted comment so a future
 * `requireSignedVersion` can pin an artifact to the release that announced it.
 */
function signFile(file) {
  const sigPath = `${file}.sig`;
  rmSync(sigPath, { force: true });
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
      'signer', 'sign', file,
      '--private-key-path', keyPath,
      '--app-version', version
    ],
    {
      cwd: ROOT,
      stdio: 'pipe',
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ''
      }
    }
  );
  if (!existsSync(sigPath)) {
    throw new Error(`APK 签名没有产出 ${sigPath}：更新清单将无法生成（缺少 signature 会让桌面端报 missing field）`);
  }
  return readFileSync(sigPath, 'utf8').trim();
}

// 2b. stage and sign the APK
// Signing happens on the STAGED file so the trusted comment's `file:` field names the asset
// the manifest actually advertises. The signature is required even though only the Android app
// downloads this asset - `tauri-plugin-updater` deserializes every `platforms` entry, so a
// signature-less entry breaks the desktop too (see scripts/release-manifest.mjs).
const apkAssetName = `MarkdownX_${version}_universal-release.apk`;
const apkStaged = apkPath ? stageFile(apkPath, apkAssetName) : null;
const apkSignature = apkStaged ? signFile(apkStaged) : null;

// 3. release notes straight from the README changelog
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const heading = `### [${tag}]`;
const start = readme.indexOf(heading);
let notes = '';
if (start !== -1) {
  // The heading line itself carries " - YYYY-MM-DD"; drop it so the notes start at the body.
  let rest = readme.slice(start + heading.length);
  rest = rest.replace(/^\s*-\s*\d{4}-\d{2}-\d{2}\s*/, '');
  const next = rest.indexOf('\n### [');
  notes = (next === -1 ? rest : rest.slice(0, next)).trim();
} else {
  notes = `MarkdownX ${tag}`;
}

const assetName = `MarkdownX_${version}_x64-setup.exe`;
const manifest = buildManifest({
  version,
  notes,
  pubDate: new Date().toISOString(),
  // Both platforms, one manifest: the desktop and the Android updaters read the same file so a
  // release can never advertise two different versions. Every entry carries a real signature -
  // `buildManifest` refuses to emit one that does not (v2.6.1 shipped a signature-less Android
  // entry and every desktop update check died with `missing field 'signature'`).
  platforms: [
    {
      platform: WINDOWS_PLATFORM,
      url: rawAssetUrl(owner, repo, ASSET_BRANCH, assetName),
      signature
    },
    ...(apkStaged
      ? [
          {
            platform: ANDROID_PLATFORM,
            url: rawAssetUrl(owner, repo, ASSET_BRANCH, apkAssetName),
            signature: apkSignature
          }
        ]
      : [])
  ]
});

const manifestPath = join(bundleDir, 'latest.json');
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('\n✓ 产物');
console.log(`   安装包:   ${installer}`);
console.log(`   签名:     ${signatureFile}`);
console.log(
  `   APK:      ${apkStaged ? `${apkStaged}  → ${apkAssetName}` : '（本次不含 Android 资产）'}`
);
if (apkStaged) console.log(`   APK 签名: ${apkStaged}.sig（必需：桌面端会解析整个 platforms 映射）`);
console.log(`   更新清单: ${manifestPath}`);
console.log(`\n   应用将拉取: https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/latest.json`);

// 5. publish through the API (api.github.com is reachable here; github.com is not)
/**
 * Resolve the GitHub CLI without trusting PATH: a winget install updates the PATH for NEW
 * processes only, so a long-lived shell (or a script started from one) may not see `gh` at
 * all. Try the environment override, then PATH, then the default install location.
 */
function ghBin() {
  const candidates = [
    process.env.GH_BIN,
    'gh',
    'C:/Program Files/GitHub CLI/gh.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('找不到 gh CLI：请安装 GitHub CLI，或用 GH_BIN 指定其完整路径');
}

/**
 * Publish the `release-assets` branch by force-pushing one fresh commit.
 *
 * Deliberately NOT the Contents API: `PUT /repos/.../contents/<file>` starts answering
 * `401 Bad credentials` for bodies above ~5 MB (verified at 13 MB - see MAINTENANCE §8.5),
 * which looks like a broken credential and is not. A git push of the same files goes through
 * the normal transport instead, and it matters now that the APK alone is 20+ MB.
 *
 * The branch is a publish target, not history: one commit, always exactly the current
 * release's files (which is also how superseded installers/APKs disappear).
 */
function publishAssetBranch(files) {
  const dir = join(bundleDir, '.release-assets');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const names = files.map((file) => basename(file));
  files.forEach((file) => copyFileSync(file, join(dir, basename(file))));

  // `-c safe.directory=*`: the staging repo lives inside the build tree, which on the NAS
  // share is owned by the file server account rather than the account running this script.
  // Git then refuses every command with "dubious ownership in repository at ..." and the
  // release cannot be published from a share checkout at all.
  const run = (args) =>
    execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd: dir, stdio: 'pipe' });
  run(['init', '-q']);
  run(['checkout', '-q', '-b', ASSET_BRANCH]);
  // Explicit paths only (never `git add -A`): `bundleDir` lives inside target/, and a stray
  // `add -A` once swept 446 MB of Android build output into a release commit (§8.6).
  run(['add', '--', ...names]);
  run([
    '-c', 'user.name=MarkdownX Maintainer',
    '-c', 'user.email=maintainer@markdownx.local',
    'commit', '-q', '-m', `release ${tag}: ${names.join(', ')}`
  ]);
  run(['push', '-f', '--quiet', remoteUrlWithToken(), `HEAD:${ASSET_BRANCH}`]);
  console.log(`   ${ASSET_BRANCH} 分支已更新: ${names.join(', ')}`);
}

/** HTTPS remote carrying the gh token; never printed - it is a credential. */
function remoteUrlWithToken() {
  const token = execFileSync(ghBin(), ['auth', 'token'], { encoding: 'utf8' }).trim();
  if (!token) throw new Error('gh auth token 为空：先执行 gh auth login');
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

function uploadFile(localPath, remoteName) {
  const apiPath = `repos/${owner}/${repo}/contents/${remoteName}`;
  let sha;
  try {
    sha = JSON.parse(gh([`${apiPath}?ref=${ASSET_BRANCH}`])).sha;
  } catch {
    sha = undefined;
  }
  const payload = join(bundleDir, `.tmp-${remoteName.replace(/[^\w.-]/g, '_')}.json`);
  writeFileSync(
    payload,
    JSON.stringify({
      message: `release ${tag}: ${remoteName}`,
      content: readFileSync(localPath).toString('base64'),
      branch: ASSET_BRANCH,
      ...(sha ? { sha } : {})
    })
  );
  gh([apiPath, '--method', 'PUT'], payload);
  console.log(`   已上传 ${remoteName}${sha ? '（覆盖）' : ''}`);
}

function verifyEndpoints() {
  const url = `https://github.com/${owner}/${repo}/releases/latest/download/latest.json`;
  let code = 'unknown';
  try {
    code = execFileSync('curl', ['-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '25', '-L', url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    code = String(err.stdout || '').trim() || 'failed';
  }
  console.log(`   ${code === '200' ? '✓' : '✗'} HTTP ${code}  ${url}`);
}

function verifyRaw() {
  // `-o /dev/null` is a POSIX path: on Windows curl exits 23 (write error) even though it
  // fetched fine, which used to crash this check. Ask curl for the code and ignore the
  // body, tolerate a non-zero exit, and treat the printed code as the verdict.
  for (const url of [`https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/latest.json`,
                     `https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/${assetName}`,
                     ...(apkPath
                       ? [`https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/${apkAssetName}`]
                       : [])]) {
    let code = 'unknown';
    try {
      // HEAD, not GET: the APK is 20+ MB and a release check must not download it.
      code = execFileSync('curl', ['-s', '-I', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '20', '-L', url],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop().trim();
    } catch (err) {
      code = String(err.stdout || '').trim().split('\n').pop().trim() || 'failed';
    }
    const ok = code === '200';
    console.log(`   ${ok ? '✓' : '✗'} HTTP ${code}  ${url}`);
    if (!ok) console.log('     （注意：raw 有几分钟缓存；刚上传后立刻取可能仍是旧内容）');
  }
}

/**
 * Copy an artifact to `bundleDir` under the name the manifest advertises.
 *
 * The APK comes out of Gradle as `app-universal-release.apk`, while the manifest points at
 * `MarkdownX_<version>_universal-release.apk`: the branch file, the Release asset and the URL
 * must all carry the same name or the download 404s.
 */
function stageFile(src, name) {
  const dest = join(bundleDir, name);
  if (resolve(src) !== resolve(dest)) copyFileSync(src, dest);
  return dest;
}

if (process.argv.includes('--publish')) {
  console.log('\n→ 发布（分支用 git 强推，资产用 gh release upload；都不走 Contents API）');
  // `apkStaged` was already staged and signed above, before the manifest was written, so the
  // published bytes and the signature in latest.json are guaranteed to describe the same file.
  const releaseAssets = [installer, manifestPath, ...(apkStaged ? [apkStaged] : [])];
  publishAssetBranch(releaseAssets);
  // Also (re)create the GitHub Release: human-facing page, tag, and the fallback endpoint.
  try {
    const notesFile = join(bundleDir, '.tmp-notes.md');
    writeFileSync(notesFile, notes + '\n');
    const args = [
      'release', 'create', tag,
      ...releaseAssets,
      '--title', `MarkdownX ${tag}`,
      '--notes-file', notesFile,
      '--latest'
    ];
    try {
      execFileSync(ghBin(), ['release', 'upload', tag, ...releaseAssets, '--clobber'], { stdio: 'pipe' });
      console.log(`   已更新 GitHub Release ${tag} 的资产`);
    } catch {
      execFileSync(ghBin(), args, { stdio: 'pipe' });
      console.log(`   已创建 GitHub Release ${tag}`);
    }
  } catch (err) {
    console.log(`   注意：GitHub Release 未创建（${String(err).split('\n')[0]}）——不影响 raw 端点`);
  }

  console.log('\n→ 实测全部端点（raw 优先，Release 兜底）');
  verifyRaw();
  verifyEndpoints();
  console.log('\n完成。raw 有几分钟缓存；客户端 20 秒后开始检查，失败会静默重试。');
} else {
  console.log('\n→ 发布：加 --publish 由脚本推送；或手动把产物放进 release-assets 分支');
  console.log(`   node scripts/release-update.mjs --owner ${owner} --repo ${repo} --apk <apk> --skip-build --publish`);
}
