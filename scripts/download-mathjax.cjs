/**
 * Standalone MathJax Offline Downloader
 * Downloads tex-svg.js and tex-chtml.js directly into public/mathjax/
 * Run: node scripts/download-mathjax.cjs
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const targetDir = path.resolve(__dirname, '..', 'public', 'mathjax');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const files = [
  {
    name: 'tex-svg.js',
    url: 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js'
  },
  {
    name: 'tex-chtml.js',
    url: 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js'
  }
];

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: status code ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log('[MathJax Downloader] Downloading offline MathJax bundles...');
  for (const item of files) {
    const dest = path.join(targetDir, item.name);
    console.log(`Downloading ${item.name} from ${item.url}...`);
    try {
      await downloadFile(item.url, dest);
      console.log(`✓ Downloaded ${item.name} (${fs.statSync(dest).size} bytes)`);
    } catch (e) {
      console.error(`✗ Failed to download ${item.name}:`, e.message);
    }
  }
  console.log('Done! Offline MathJax assets are stored in public/mathjax/');
}

main();
