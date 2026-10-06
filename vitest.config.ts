import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts on purpose: the app config carries the
// MathJax/Mermaid asset plugin whose `buildStart` copies vendor bundles, which
// has nothing to do with unit tests. Tests here are pure-logic, Node-only.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});