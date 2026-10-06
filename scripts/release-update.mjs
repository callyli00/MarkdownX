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
 *   3. Writes latest.json in the format the Tauri updater expects.
 *   4. Prints the two commands that publish it (GitHub CLI, or the manual route).
 *
 * Release notes come from this project's README changelog: the newest `### [vX.Y.Z]`
 * section is used verbatim, so notes live in exactly one place.
 *
 * The private key: pass its path via TAURI_SIGNING_PRIVATE_KEY_PATH, or leave it at the
 * default location used by `tauri signer generate` on this machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/${assetName}`
    }
  }
};

const manifestPath = join(bundleDir, 'latest.json');
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('\n✓ 产物');
console.log(`   安装包:   ${installer}`);
console.log(`   签名:     ${signatureFile}`);
console.log(`   更新清单: ${manifestPath}`);
console.log(`\n   应用将拉取: https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/latest.json`);

// 5. publish through the API (api.github.com is reachable here; github.com is not)
function gh(args, inputFile) {
  const full = ['api', ...args];
  if (inputFile) full.push('--input', inputFile);
  return execFileSync('gh', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function ensureAssetBranch() {
  try {
    gh([`repos/${owner}/${repo}/git/ref/heads/${ASSET_BRANCH}`]);
    console.log(`   ${ASSET_BRANCH} 分支已存在`);
    return;
  } catch {
    /* does not exist yet */
  }
  const head = JSON.parse(gh([`repos/${owner}/${repo}/git/ref/heads/main`]));
  const payload = join(bundleDir, '.tmp-branch.json');
  writeFileSync(payload, JSON.stringify({ ref: `refs/heads/${ASSET_BRANCH}`, sha: head.object.sha }));
  gh([`repos/${owner}/${repo}/git/refs`, '--method', 'POST'], payload);
  console.log(`   已创建 ${ASSET_BRANCH} 分支（基于 main）`);
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

function verifyRaw() {
  for (const url of [`https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/latest.json`,
                     `https://raw.githubusercontent.com/${owner}/${repo}/${ASSET_BRANCH}/${assetName}`]) {
    const code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', '-L', url], { encoding: 'utf8' }).trim();
    console.log(`   ${code === '200' ? '✓' : '✗'} HTTP ${code}  ${url}`);
  }
}

if (process.argv.includes('--publish')) {
  console.log('\n→ 经 GitHub API 发布（api.github.com 可达，绕开 github.com）');
  ensureAssetBranch();
  uploadFile(installer, assetName);
  uploadFile(manifestPath, 'latest.json');
  console.log('\n→ 实测两个 raw 地址（应用启动时拉的就是它们）');
  verifyRaw();
  console.log('\n完成。raw 有几分钟缓存；客户端 20 秒后开始检查，失败会静默重试。');
} else {
  console.log('\n→ 发布：加 --publish 由脚本经 API 上传；或手动把两个文件放进 release-assets 分支');
  console.log(`   node scripts/release-update.mjs --owner ${owner} --repo ${repo} --skip-build --publish`);
}
