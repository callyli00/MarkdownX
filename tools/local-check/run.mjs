/**
 * Local test runner for machines where the repository sits on a UNC path.
 *
 * Vite/Vitest treat a UNC project root as a POSIX path (`\\host\share\x` -> `/host/share/x`)
 * and fail during startup, long before any test runs. This runner keeps the SAME test
 * files: it bundles each one with esbuild (aliasing `vitest` to a small shim and
 * `@tauri-apps/api/core` to a stub), writes the bundle to the local temp directory and
 * imports it. Only the modules a test actually imports are bundled, so nothing else needs
 * to move off the network share.
 *
 * Usage:
 *   node tools/local-check/run.mjs src/utils/__tests__/wikiLink.test.ts [more.test.ts ...]
 *   node tools/local-check/run.mjs --all        # every test file under src/
 *
 * Exit code 0 only when every assertion passed.
 */

import { readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function collectTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectTestFiles(full, out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const files = args.includes('--all')
  ? collectTestFiles(path.join(repoRoot, 'src')).sort()
  : args;

if (files.length === 0) {
  console.error('usage: node tools/local-check/run.mjs <test-file...> | --all');
  process.exit(2);
}

const shimUrl = pathToFileURL(path.join(here, 'vitest-shim.mjs')).href;
const tauriStubUrl = pathToFileURL(path.join(here, 'tauri-stub.mjs')).href;
const aliasPlugin = {
  name: 'local-check-aliases',
  setup(build) {
    build.onResolve({ filter: /^vitest$/ }, () => ({ path: shimUrl, external: true }));
    build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: tauriStubUrl, external: true }));
  }
};

let totalPassed = 0;
const allFailures = [];

for (const file of files) {
  const entry = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  const outDir = mkdtempSync(path.join(tmpdir(), 'mdx-check-'));
  const outfile = path.join(outDir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    plugins: [aliasPlugin]
  });

  console.log(`\n▶ ${path.relative(repoRoot, entry)}`);
  try {
    globalThis.__mdxReset?.();
    await import(pathToFileURL(outfile).href);
  } catch (err) {
    // A module-level throw is a failure of that file, not of the run: keep going so one
    // broken bundle cannot hide the state of the other suites.
    allFailures.push({ file: entry, full: '(module load)', error: err });
    console.log(`  ✗ (module load) ${err?.message || err}`);
    continue;
  }
  const result = await globalThis.__mdxRun();
  totalPassed += result.passed;
  for (const failure of result.failures) allFailures.push({ file: entry, ...failure });
}

console.log(`\n${totalPassed} passed, ${allFailures.length} failed`);
if (allFailures.length > 0) {
  console.log('\nFailures:');
  for (const f of allFailures) {
    console.log(`  ✗ ${path.relative(repoRoot, f.file)} › ${f.full}`);
    console.log(`      ${f.error?.stack || f.error}`);
  }
  process.exit(1);
}
