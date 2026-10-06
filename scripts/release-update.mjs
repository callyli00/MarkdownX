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
      url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${assetName}`
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
console.log('\n→ 发布（任选其一）');
console.log(`   有 GitHub CLI：gh release create ${tag} "${installer}" "${manifestPath}" --title ${tag} --notes-file -`);
console.log('   手动：在 GitHub 上创建 Release');
console.log(`         - tag: ${tag}`);
console.log(`         - 上传两个文件：${assetName} 与 latest.json`);
console.log('\n注意：latest.json 必须能被匿名访问（release 资产可以），因为应用在启动时直接拉取它。');
console.log('另外别忘了把 tauri.conf.json 的 plugins.updater.endpoints 指向：');
console.log(`   https://github.com/${owner}/${repo}/releases/latest/download/latest.json`);