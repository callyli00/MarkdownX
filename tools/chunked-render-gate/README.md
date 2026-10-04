# Chunked-render equivalence gate

Safety net for the v2 rendering work (chunked / sliced / worker-side rendering).

`src/utils/markdownRenderer.ts` renders a document **per top-level block**. v2 wants
to exploit that: render the first blocks immediately, the rest in time slices, in a
Web Worker, and typeset math only for what is on screen. Every step of that plan is
only safe while a chunked render stays **byte-identical** to a whole-document render,
so that is what this gate proves.

```bash
node tools/chunked-render-gate/gate.cjs      # exit 0 = green, 1 = regression
```

It builds the real renderer with esbuild (stubbing `@tauri-apps/api/core`), then for
each document in `corpus/`:

| Check | Why |
|---|---|
| whole-document render == `golden/*.html` | the public API must stay behaviour-stable |
| chunked render == golden, for split sizes 1/2/3/5/10/half/all | blocking is lossless **and** size-independent |
| first divergent byte is reported | a failure must be actionable, not just "differs" |

## Invariants (keep these green, they encode real constraints)

1. **Blocking is lossless.** `finalize(concat(renderBlockRange(i..j) for all chunks))`
   must equal the single-pass render — including `data-src-*` anchors, heading ids,
   equation numbers and `\eqref` links.
2. **Blocks must be rendered in ascending order, exactly once.** Heading id
   de-duplication lives in the renderer's own state (`headingIdCounts`), so a suffix
   depends on how many identical headings came before. Out-of-order or repeated
   renders produce drifting ids — the gate fails with `+NB` and a divergence offset.
3. **Renderer state is per-document.** Call `prepareDocument()` once per document
   revision; it resets the renderer. Re-using one prepared document for several
   independent renders leaks the counters (this bit the gate harness itself).
4. **`convertFileSrc` must resolve.** The stub is `.cjs` on purpose: `package.json`
   sets `"type": "module"`, and a `.js` stub is loaded as ESM, leaving the named
   import undefined — asset URLs then silently stop being rewritten and the gate
   would validate a broken path.

## Adding a case

Drop a `.md` file into `corpus/` and generate its golden file from a release you
trust:

```bash
node tools/chunked-render-gate/gate.cjs          # reports "missing golden"
# then produce it with the renderer at that revision and review the diff before committing
```

Corpus coverage today: publisher-exported book fragments (`<figure>`, `<span class="math">`
wrapping bare TeX, three-line tables, duplicate headings, `\[35\]` citations), math with
`\label`/`\eqref`/`\ref`, fenced code + Mermaid + blockquote + nested lists, and plain
prose. Keep at least one document per rendering subsystem when adding cases.