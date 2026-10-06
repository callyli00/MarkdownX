/**
 * Copy the CJK note font (Noto Sans SC Regular) out of node_modules into
 * public/fonts/, so PDF annotation notes can render Chinese when flattened.
 *
 * Why this font: it is SIL OFL licensed, so embedding it into a produced PDF and
 * redistributing that PDF is allowed. Windows system fonts (msyh.ttc, simsun.ttc)
 * are NOT usable — the Microsoft EULA forbids embedding/redistribution — and .ttc
 * collections are awkward for pdf-lib.
 *
 * The source lives in a per-weight subdirectory, e.g.
 *   node_modules/@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const src = path.resolve(
  projectRoot,
  'node_modules',
  '@expo-google-fonts',
  'noto-sans-sc',
  '400Regular',
  'NotoSansSC_400Regular.ttf'
);
const targetDir = path.resolve(projectRoot, 'public', 'fonts');
const target = path.join(targetDir, 'NotoSansSC-Regular.ttf');

if (!fs.existsSync(src)) {
  console.log('[CJK font] Noto Sans SC not found (run npm install). Notes fall back to Latin-only.');
  process.exit(0);
}
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(src, target);
const size = fs.statSync(target).size;
console.log(`\u2713 copied NotoSansSC-Regular.ttf (${(size / 1024 / 1024).toFixed(1)} MB) -> public/fonts/`);