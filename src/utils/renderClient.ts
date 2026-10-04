/**
 * Main-thread render client: prefers the Worker, degrades to the synchronous path.
 *
 * Design rule (the whole point of this file): the Worker is a pure optimization.
 * If it is missing, fails to load, throws, or hangs, the caller silently gets the
 * exact behaviour it had before the Worker existed - i.e.
 * finalizeAssetUrls(await renderMarkdownPayload(...)) on the main thread. There is
 * therefore no state in which a document fails to render because of the Worker.
 *
 * Small documents skip the Worker entirely (below WORKER_MIN_CHARS): spinning one
 * up and posting a message costs more than parsing a few KB, and this keeps the
 * everyday path byte-identical to the pre-Worker build.
 */

import { finalizeAssetUrls, renderMarkdownPayload } from './markdownRenderer';

/** Documents at least this large are worth handing to the Worker. */
const WORKER_MIN_CHARS = 20000;
/** A Worker that produces nothing for this long is treated as broken. */
const RENDER_TIMEOUT_MS = 30000;

export type RenderEngine = 'worker' | 'sync';
export type WorkerHealth = 'idle' | 'ready' | 'broken';

export interface RenderOutcome {
  html: string;
  engine: RenderEngine;
  /** Parse duration in ms (worker-side measurement when engine === 'worker'). */
  ms?: number;
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (html: string, ms?: number) => void; reject: (err: unknown) => void; basePath: string }
>();

function failAllPending(reason: string): void {
  for (const [, entry] of pending) entry.reject(new Error(reason));
  pending.clear();
}

function markBroken(reason: unknown): void {
  if (workerBroken) return;
  workerBroken = true;
  console.warn('[MarkdownX] render worker unavailable, falling back to the main thread:', reason);
  failAllPending(String(reason));
  try {
    worker?.terminate();
  } catch {
    /* already gone */
  }
  worker = null;
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    const next = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' });
    next.onmessage = (event: MessageEvent<{ id: number; html?: string; error?: string; ms?: number }>) => {
      const data = event.data;
      if (!data || typeof data.id !== 'number') return;
      const entry = pending.get(data.id);
      if (!entry) return; // stale (superseded by a newer render)
      pending.delete(data.id);
      if (typeof data.html === 'string') {
        // Host-dependent last pass, exactly as the synchronous path does it.
        entry.resolve(finalizeAssetUrls(data.html, entry.basePath), data.ms);
      } else {
        entry.reject(new Error(data.error || 'render worker returned no html'));
      }
    };
    next.onerror = (event: ErrorEvent) => {
      markBroken(event?.message || 'worker error');
    };
    next.onmessageerror = () => {
      markBroken('worker message could not be deserialized');
    };
    worker = next;
    return next;
  } catch (err) {
    markBroken(err);
    return null;
  }
}

export function workerHealth(): WorkerHealth {
  if (workerBroken) return 'broken';
  return worker ? 'ready' : 'idle';
}

/** True when the next large render will actually run off the main thread. */
export function workerWillBeUsed(charCount: number): boolean {
  return charCount >= WORKER_MIN_CHARS && !workerBroken;
}

/**
 * Render a document, preferring the Worker for large inputs.
 * Never rejects for Worker-related reasons: it falls back instead.
 */
export async function renderDocument(raw: string, documentBasePath: string): Promise<RenderOutcome> {
  const useWorker = !workerBroken && raw.length >= WORKER_MIN_CHARS;
  const active = useWorker ? ensureWorker() : null;

  if (!active) {
    return { html: finalizeAssetUrls(await renderMarkdownPayload(raw), documentBasePath), engine: 'sync' };
  }

  const id = (seq += 1);
  const viaWorker = new Promise<{ html: string; ms?: number }>((resolve, reject) => {
    pending.set(id, { resolve: (html, ms) => resolve({ html, ms }), reject, basePath: documentBasePath });
    try {
      active.postMessage({ id, raw });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        markBroken('worker timed out');
      }
      reject(new Error('render worker timed out'));
    }, RENDER_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([viaWorker, timeout]);
    return { html: result.html, engine: 'worker', ms: result.ms };
  } catch (err) {
    // Degrade, never fail: the document still renders, only on the main thread.
    console.warn('[MarkdownX] worker render failed, using the main thread:', err);
    return { html: finalizeAssetUrls(await renderMarkdownPayload(raw), documentBasePath), engine: 'sync' };
  }
}