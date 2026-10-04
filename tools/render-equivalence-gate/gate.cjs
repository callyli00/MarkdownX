/**
 * Render equivalence gate.
 *
 * Proves, on a corpus, that the Worker path and the synchronous path produce
 * byte-for-byte identical HTML:
 *
 *   renderMarkdown(raw, base)                                      <- today's path
 *   finalizeAssetUrls(renderMarkdownPayload(raw), base)            <- Worker path
 *
 * and, for the documents that carry a stored golden file from the pre-Worker era,
 * that today's output has not drifted from it at all.
 *
 * Why this is the gate that matters: the Worker split defers the Tauri-dependent
 * asset rewrite to the main thread. If that deferral changed a single character,
 * images, anchors or math markup could differ between the two paths, and a user
 * would see it before we did. This runs in Node against the real renderer module.
 *
 * The corpus and the goldens were recovered from the pre-Worker implementation, so
 * the golden comparison also proves the v1.9.6 rollback changed no renderer output.
 *
 * Run: node tools/render-equivalence-gate/gate.cjs
 */

const path = require('path');
const fs = require('fs');
const { buildSync } = require('esbuild');

const ENTRY = path.join(__dirname, 'entry.ts');
const OUT_DIR = path.join(__dirname, '.build');
const OUT = path.join(OUT_DIR, 'renderer.cjs');
const CORPUS = path.join(__dirname, 'corpus');
const GOLDEN = path.join(__dirname, 'golden');
/** Same base path the golden files were produced with. */
const BASE_PATH = 'C:/docs/book';

fs.mkdirSync(OUT_DIR, { recursive: true });

buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: OUT,
  // The renderer imports the Tauri bridge only for convertFileSrc; in Node that
  // becomes the host stub (a .cjs file, so the named import stays intact).
  alias: { '@tauri-apps/api/core': path.join(__dirname, 'stub-core.cjs') },
  logLevel: 'warning'
});

const api = require(OUT);

/** First differing character, with context - a bare "not equal" would be useless. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      const from = Math.max(0, i - 70);
      return {
        index: i,
        sync: JSON.stringify(a.slice(from, i + 70)),
        worker: JSON.stringify(b.slice(from, i + 70))
      };
    }
  }
  return {
    index: n,
    sync: JSON.stringify(a.slice(Math.max(0, n - 70))),
    worker: JSON.stringify(b.slice(Math.max(0, n - 70))),
    note: a.length === b.length ? 'equal up to length' : `length differs: sync=${a.length} worker=${b.length}`
  };
}

(async () => {
  const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.md')).sort();
  let pass = 0;
  let fail = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(CORPUS, file), 'utf8');
    const sync = await api.renderMarkdown(raw, BASE_PATH);
    const worker = api.finalizeAssetUrls(await api.renderMarkdownPayload(raw), BASE_PATH);

    const goldenPath = path.join(GOLDEN, `${file}.html`);
    const golden = fs.existsSync(goldenPath) ? fs.readFileSync(goldenPath, 'utf8') : null;

    const samePath = sync === worker;
    const noDrift = golden === null ? null : sync === golden;

    // Content assertion, independent of either path: a document that writes display
    // math must actually come out as math markup. This is the regression guard for
    // the class of bug where the tokenizer silently stops seeing formulas (CRLF +
    // code fences did exactly that: everything after the first fence was masked
    // away, so its formulas rendered as raw $$ source).
    const wantDisplay = (raw.match(/\$\$/g) || []).length / 2;
    const gotDisplay = ((sync.match(/class="math-equation-row"/g) || []).length);
    const mathRendered = wantDisplay === 0 || gotDisplay > 0;

    const ok = samePath && noDrift !== false && mathRendered;

    const tags = [
      `worker≡sync=${samePath ? 'yes' : 'NO'}`,
      noDrift === null ? 'golden=none' : `golden-match=${noDrift ? 'yes' : 'NO'}`,
      `displayMath=${gotDisplay}${wantDisplay > 0 ? `/${wantDisplay}` : ''}`,
      `crlf=${raw.includes('\r\n') ? 'yes' : 'no'}`,
      `chars=${sync.length}`
    ].join('  ');

    if (ok) {
      pass += 1;
      console.log(`PASS  ${file}  ${tags}`);
    } else {
      fail += 1;
      console.log(`FAIL  ${file}  ${tags}`);
      if (!samePath) {
        const d = firstDiff(sync, worker);
        console.log(`      first difference at char ${d.index}${d.note ? ` (${d.note})` : ''}`);
        console.log(`      sync  : ${d.sync}`);
        console.log(`      worker: ${d.worker}`);
      }
      if (noDrift === false) {
        const d = firstDiff(sync, golden);
        console.log(`      drift vs golden at char ${d.index}${d.note ? ` (${d.note})` : ''}`);
        console.log(`      now   : ${d.sync}`);
        console.log(`      golden: ${d.worker}`);
      }
    }
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail} documents equivalent`);

  // ---------------------------------------------------------------------------
  // Line-ending equivalence: the same document written with LF and with CRLF must
  // render to the same structure. Byte equality cannot be expected (CRLF carries an
  // extra byte per line, so source anchors legitimately differ), but the number of
  // formulas, code blocks, headings and anchors must match exactly.
  //
  // This is the check that catches a whole family of silent failures: the tokenizer
  // used to stop seeing formulas after the first code fence in CRLF documents, so a
  // Windows-authored technical document lost every formula past its first snippet
  // while looking perfectly fine in an LF-authored test file.
  // ---------------------------------------------------------------------------
  console.log('\n--- line-ending equivalence (LF vs CRLF) ---');
  let leFail = 0;
  const tally = (html) => {
    // Injected notices (e.g. the unclosed-Mermaid hint) are UI, not source content:
    // depending on how the tail tokenizes they may or may not inherit the block's
    // source anchor, which is not a behavioural difference. Normalise it out so the
    // anchor count keeps testing real source-mapped content only.
    const normalized = html.replace(
      /<div[^>]*class="mermaid-unclosed-hint"[^>]*>/g,
      (tag) => tag.replace(/\sdata-src-(start|end)="[^"]*"/g, '')
    );
    return {
      display: (normalized.match(/class="math-equation-row"/g) || []).length,
      inline: (normalized.match(/class="math-inline"/g) || []).length,
      code: (normalized.match(/<pre><code/g) || []).length,
      headings: (normalized.match(/<h[1-6][\s>]/g) || []).length,
      anchors: (normalized.match(/data-src-start=/g) || []).length
    };
  };

  for (const file of files) {
    const source = fs.readFileSync(path.join(CORPUS, file), 'utf8');
    const lf = source.replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = tally(await api.renderMarkdown(lf, BASE_PATH));
    const b = tally(await api.renderMarkdown(crlf, BASE_PATH));
    const diffs = Object.keys(a).filter((k) => a[k] !== b[k]);
    if (diffs.length === 0) {
      console.log(`PASS  ${file}  LF and CRLF agree  (display=${a.display} inline=${a.inline} code=${a.code})`);
    } else {
      leFail += 1;
      console.log(`FAIL  ${file}  line endings change the output:`);
      for (const k of diffs) console.log(`      ${k}: LF=${a[k]}  CRLF=${b[k]}`);
    }
  }
  console.log(`\n${leFail === 0 ? 'PASS' : 'FAIL'} line-ending equivalence ${files.length - leFail}/${files.length}`);

  process.exit(fail === 0 && leFail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('gate crashed:', err);
  process.exit(2);
});