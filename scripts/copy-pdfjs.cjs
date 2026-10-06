/**
 * Copy PDF.js offline assets (cMaps + standard fonts) out of node_modules into
 * public/pdfjs/, so the packaged app can render CJK and standard-font PDFs with
 * no network access. Mirrors scripts/copy-mathjax.cjs.
 *
 * Why cMaps matter: a Chinese PDF that references a CID font needs its CMap to
 * map character codes to glyphs. Without it, pdf.js renders blanks/boxes.
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const pdfjsDir = path.resolve(projectRoot, 'node_modules', 'pdfjs-dist');
const targetDir = path.resolve(projectRoot, 'public', 'pdfjs');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(pdfjsDir)) {
  console.log('[PDF.js] node_modules/pdfjs-dist not found (run npm install).');
  process.exit(0);
}

const cmaps = path.join(pdfjsDir, 'cmaps');
const fonts = path.join(pdfjsDir, 'standard_fonts');

if (fs.existsSync(cmaps)) {
  copyDir(cmaps, path.join(targetDir, 'cmaps'));
  console.log('\u2713 copied cmaps -> public/pdfjs/cmaps/');
}
if (fs.existsSync(fonts)) {
  copyDir(fonts, path.join(targetDir, 'standard_fonts'));
  console.log('\u2713 copied standard_fonts -> public/pdfjs/standard_fonts/');
}
console.log('PDF.js offline assets ready.');