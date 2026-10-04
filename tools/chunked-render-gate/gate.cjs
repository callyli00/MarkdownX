#!/usr/bin/env node
/**
 * Chunked-render equivalence gate.
 *
 * Proves that rendering a document in BLOCK CHUNKS yields byte-identical HTML to
 * rendering it in one pass, and that both still match the committed golden
 * files. Every v2 rendering change must keep this green.
 *
 *   node tools/chunked-render-gate/gate.cjs
 *
 * Invariants under test (see README):
 *   1. blocking is lossless          - chunk concatenation == whole-document render
 *   2. blocking is size-independent  - holds for every tested split size
 *   3. output is stable              - byte-identical to golden/*.html
 *   4. state is per-document         - a fresh prepass reproduces the same output
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILD_DIR = path.join(__dirname, '.build');
const BUNDLE = path.join(BUILD_DIR, 'renderer.cjs');
const CORPUS = path.join(__dirname, 'corpus');
const GOLDEN = path.join(__dirname, 'golden');

function build() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const esbuild = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  const r = spawnSync(esbuild, [
    path.join(__dirname, 'entry.ts'),
    '--bundle', '--format=cjs', '--platform=node',
    `--outfile=${BUNDLE}`,
    `--alias:@tauri-apps/api/core=${path.join(__dirname, 'stub-core.cjs')}`
  ], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !fs.existsSync(BUNDLE)) {
    console.error('gate: failed to build the renderer bundle');
    process.exit(2);
  }
}

build();
const { prepareDocument, renderBlockRange, finalizeDocument, renderMarkdown } = require(BUNDLE);

(async () => {
const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.md')).sort();
let failures = 0;
const rows = [];

for (const file of files) {
  const source = fs.readFileSync(path.join(CORPUS, file), 'utf8');
  const goldenPath = path.join(GOLDEN, file + '.html');
  const problems = [];

  if (!fs.existsSync(goldenPath)) {
    problems.push('missing golden');
    failures++;
    rows.push({ file, note: 'MISSING GOLDEN' });
    continue;
  }
  const golden = fs.readFileSync(goldenPath, 'utf8');

  // one-pass render must equal the golden file (public API unchanged)
  const onePass = await renderMarkdown(source, 'C:/docs/book');
  if (onePass !== golden) problems.push(`whole-doc render differs from golden (${onePass.length - golden.length}B)`);

  const total = prepareDocument(source, 'C:/docs/book').blocks.length;
  const sizes = [...new Set([1, 2, 3, 5, 10, Math.max(1, total >> 1), total])];
  const splitNotes = [];

  for (const size of sizes) {
    // fresh prepass per size: renderer counters are per-document state
    const prep = prepareDocument(source, 'C:/docs/book');
    let html = '';
    for (let i = 0; i < prep.blocks.length; i += size) {
      html += renderBlockRange(prep, i, Math.min(i + size, prep.blocks.length));
    }
    const out = finalizeDocument(html, prep);
    const ok = out === golden;
    if (!ok) {
      problems.push(`chunk=${size} differs by ${out.length - golden.length}B`);
      const n = Math.min(out.length, golden.length);
      let k = 0;
      while (k < n && out[k] === golden[k]) k++;
      problems.push(`   first divergence at byte ${k}`);
    }
    splitNotes.push(`c${size}${ok ? '' : '*'}`);
  }

  if (problems.length) failures++;
  rows.push({ file, blocks: total, splits: splitNotes.join(' '), ok: problems.length === 0 });
  for (const p of problems) console.log(`  ! ${file}: ${p}`);
}

console.log('\nchunked-render-gate');
console.log('file'.padEnd(50) + 'blocks   splits');
for (const r of rows) {
  console.log(String(r.file).slice(0, 48).padEnd(50) + String(r.blocks ?? '-').padStart(5) + '   ' + (r.splits ?? r.note));
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} - ${files.length - failures}/${files.length} documents equivalent at every split size`);
process.exit(failures === 0 ? 0 : 1);
})();