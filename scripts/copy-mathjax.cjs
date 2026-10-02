const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const mathjaxNodeDir = path.resolve(projectRoot, 'node_modules', 'mathjax', 'es5');
const targetPublicDir = path.resolve(projectRoot, 'public', 'mathjax');

// Text-to-diagram engine: ship the UMD build so diagrams work fully offline.
const mermaidSource = path.resolve(projectRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const mermaidTargetDir = path.resolve(projectRoot, 'public', 'mermaid');
const mermaidTarget = path.join(mermaidTargetDir, 'mermaid.min.js');
if (fs.existsSync(mermaidSource)) {
  fs.mkdirSync(mermaidTargetDir, { recursive: true });
  fs.copyFileSync(mermaidSource, mermaidTarget);
  console.log('\u2713 Successfully copied mermaid.min.js to public/mermaid/');
} else {
  console.log('[Diagram] Note: node_modules/mermaid not found yet (run npm install).');
  console.log('  The app will fall back to the public CDN automatically.');
}

console.log('[MathJax Offline Packager] Checking local MathJax resources...');

function copyFolderRecursiveSync(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  const files = fs.readdirSync(source);
  files.forEach(file => {
    const curSource = path.join(source, file);
    const curTarget = path.join(target, file);
    if (fs.lstatSync(curSource).isDirectory()) {
      copyFolderRecursiveSync(curSource, curTarget);
    } else {
      fs.copyFileSync(curSource, curTarget);
    }
  });
}

if (!fs.existsSync(targetPublicDir)) {
  fs.mkdirSync(targetPublicDir, { recursive: true });
}

if (fs.existsSync(mathjaxNodeDir)) {
  console.log(`[MathJax Offline Packager] Found MathJax in node_modules: ${mathjaxNodeDir}`);
  
  // 1. Copy tex-svg.js (Primary Vector Engine)
  const svgSource = path.join(mathjaxNodeDir, 'tex-svg.js');
  if (fs.existsSync(svgSource)) {
    fs.copyFileSync(svgSource, path.join(targetPublicDir, 'tex-svg.js'));
    console.log('✓ Successfully copied tex-svg.js to public/mathjax/');
  }

  // 2. Copy tex-chtml.js (Fast CHTML Engine)
  const chtmlSource = path.join(mathjaxNodeDir, 'tex-chtml.js');
  if (fs.existsSync(chtmlSource)) {
    fs.copyFileSync(chtmlSource, path.join(targetPublicDir, 'tex-chtml.js'));
    console.log('✓ Successfully copied tex-chtml.js to public/mathjax/');
  }

  // 3. Copy CHTML fonts if present
  const fontsSource = path.join(mathjaxNodeDir, 'output', 'chtml', 'fonts');
  if (fs.existsSync(fontsSource)) {
    const fontsTarget = path.join(targetPublicDir, 'output', 'chtml', 'fonts');
    copyFolderRecursiveSync(fontsSource, fontsTarget);
    console.log('✓ Successfully copied CHTML fonts to public/mathjax/output/chtml/fonts/');
  }

  // 4. Copy the TeX extension set. The combined tex-svg/tex-chtml bundles only
  //    embed a subset of packages; anything else (\boldsymbol, \bm, \cancel,
  //    \color, mhchem, physics, ...) is fetched at runtime by the autoload
  //    extension. Without these files the fetch fails and MathJax rejects the
  //    WHOLE typeset pass, so every equation on the page degrades to raw text.
  const extSource = path.join(mathjaxNodeDir, 'input', 'tex', 'extensions');
  if (fs.existsSync(extSource)) {
    const extTarget = path.join(targetPublicDir, 'input', 'tex', 'extensions');
    copyFolderRecursiveSync(extSource, extTarget);
    console.log('✓ Successfully copied TeX extensions to public/mathjax/input/tex/extensions/');
  }

  console.log('🎉 MathJax offline localization completed! Standalone builds will run 100% offline.');
} else {
  console.log('[MathJax Offline Packager] Note: node_modules/mathjax not found yet.');
  console.log('  If installing via pnpm, run: "pnpm add mathjax@3" or "pnpm install".');
  console.log('  The app will fall back to local public/mathjax or secure CDN automatically if offline files are missing.');
}
