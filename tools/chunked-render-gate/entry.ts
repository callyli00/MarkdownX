// Gate entry: re-export the chunked renderer API from the real source module.
// Lives inside the project so esbuild resolves `marked` / `highlight.js`.
export { renderMarkdown, prepareDocument, renderBlockRange, finalizeDocument } from '../../src/utils/markdownRenderer';