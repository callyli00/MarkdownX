// Gate entry: re-export the renderer's public surface from the real source module.
// Lives inside the project so esbuild resolves `marked` / `highlight.js`.
// `renderMarkdown` = the synchronous (pre-Worker) path; `renderMarkdownPayload` +
// `finalizeAssetUrls` = the Worker path. The gate asserts they agree byte-for-byte.
export {
  renderMarkdown,
  renderMarkdownPayload,
  finalizeAssetUrls
} from '../../src/utils/markdownRenderer';