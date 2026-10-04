/**
 * Render Worker: runs the whole-document Markdown -> HTML parse off the main thread.
 *
 * Constraints that shaped this file
 * ---------------------------------
 * 1. The parse is pure string -> string except for ONE host-dependent step: the
 *    final asset-URL rewrite (Tauri's convertFileSrc bridge, main thread only).
 *    So the worker calls renderMarkdownPayload() - which leaves every asset path
 *    exactly as written - and the host runs finalizeAssetUrls() on the result.
 *    Both funnel through the same resolveLocalAssetUrl(), so the deferred rewrite
 *    cannot change the outcome; tools/render-equivalence-gate proves it.
 * 2. No DOM, no window, no typesetting here: the math/diagram HTML is produced as
 *    markup (tokens restored), and MathJax/Mermaid are driven by the host exactly
 *    as before. This file must never grow a DOM dependency.
 * 3. One message in, one message out. Failures are reported, never swallowed - the
 *    host falls back to the synchronous path when it sees one.
 */

import { renderMarkdownPayload } from './markdownRenderer';

interface RenderRequest {
  id: number;
  raw: string;
}

interface RenderResponse {
  id: number;
  html?: string;
  error?: string;
  /** Parse duration in ms, for diagnostics on the host side. */
  ms?: number;
}

const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const data = event.data;
  if (!data || typeof data.id !== 'number' || typeof data.raw !== 'string') return;
  const started = Date.now();
  try {
    const html = await renderMarkdownPayload(data.raw);
    const message: RenderResponse = { id: data.id, html, ms: Date.now() - started };
    ctx.postMessage(message);
  } catch (err) {
    const message: RenderResponse = { id: data.id, error: String(err), ms: Date.now() - started };
    ctx.postMessage(message);
  }
};