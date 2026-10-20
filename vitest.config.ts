import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts on purpose: the app config carries the
// MathJax/Mermaid asset plugin whose `buildStart` copies vendor bundles, which
// has nothing to do with unit tests. Tests here are pure-logic, Node-only.
export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/**/*.test.mjs` guards build-time output the app consumes at runtime (the updater
    // manifest). It stays plain JS on purpose: `tsconfig.json` includes only `src`, so release
    // tooling is deliberately outside the type-checked program.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});