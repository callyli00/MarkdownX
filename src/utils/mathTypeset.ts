/**
 * On-demand math typesetting (v2 stage 3).
 *
 * Why this exists
 * ---------------
 * Typesetting the whole document at once is the dominant cost of opening a
 * formula-dense paper, and it is wasted work: most formulas are never seen.
 * Wrapping the engine per CHUNK is not enough either, because the chunked preview
 * mounts several thousand blocks per chunk - so the unit of lazy work here is the
 * individual math container (`.math-equation-row` / `.math-inline`).
 *
 * Guarantees
 * ----------
 * - A container is typeset when it comes near the viewport, and never twice:
 *   containers already holding an `mjx-container` are skipped.
 * - Batched: visible containers are collected and handed to the engine in ONE
 *   call, because the app's engine wrapper resets global TeX state per call.
 * - Single-flight: only one batch runs at a time, so a global reset can never
 *   interleave with a queued typeset promise.
 * - Loud: if the engine never becomes usable the session reports `missing` (or
 *   `error`) instead of silently dropping every formula.
 */

export type MathEngineState = 'unknown' | 'loading' | 'ready' | 'missing' | 'error';

export interface MathTypesetStatus {
  engine: MathEngineState;
  /** Containers handed to the engine so far. */
  typeset: number;
  /** Containers still needing typesetting (queued or waiting to come into range). */
  pending: number;
  error: string | null;
}

export interface MathTypesetSession {
  /** Re-scan the root for containers that still need typesetting. */
  refresh(): void;
  /** Typeset every remaining container now (export / print / tests). */
  typesetAll(): Promise<void>;
  /** Stop observing and drop queued work. */
  destroy(): void;
}

const MATH_SELECTOR = '.math-equation-row, .math-inline';
/** How far outside the viewport a container is prepared. */
const PRELOAD_MARGIN = '1200px 0px 1200px 0px';
/** Engine readiness budget; the app's own loader has CDN fallbacks behind it. */
const ENGINE_WAIT_MS = 10000;
/** Batch window: collect what scrolled into range, then typeset once. */
const BATCH_DELAY_MS = 40;

type MathJaxLike = {
  typesetPromise?: (elements?: HTMLElement[]) => Promise<void>;
  typesetClear?: (elements?: HTMLElement[]) => void;
  texReset?: () => void;
  startup?: { promise?: Promise<unknown> };
};

function getMathJax(): MathJaxLike | undefined {
  return (window as unknown as { MathJax?: MathJaxLike }).MathJax;
}

function needsTypesetting(el: Element): boolean {
  return !el.querySelector('mjx-container');
}

export function createMathTypesetSession(
  root: HTMLElement,
  onStatus: (status: MathTypesetStatus) => void
): MathTypesetSession {
  let engine: MathEngineState = 'unknown';
  let error: string | null = null;
  let typeset = 0;
  let destroyed = false;
  let running = false;

  const queue = new Set<HTMLElement>();
  /** Containers seen but not yet typeset (observed from a distance). */
  const waiting = new Set<HTMLElement>();
  let flushTimer: number | null = null;
  let observer: IntersectionObserver | null = null;

  const pendingCount = () => queue.size + waiting.size;

  const push = () => {
    if (destroyed) return;
    onStatus({ engine, typeset, pending: pendingCount(), error });
  };

  const waitForEngine = async (): Promise<boolean> => {
    const existing = getMathJax();
    if (existing?.typesetPromise) {
      try {
        await existing.startup?.promise;
      } catch {
        /* startup rejection is not fatal: typesetPromise may still work */
      }
      engine = 'ready';
      return true;
    }
    engine = 'loading';
    push();
    const deadline = Date.now() + ENGINE_WAIT_MS;
    while (!destroyed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const mj = getMathJax();
      if (mj?.typesetPromise) {
        try {
          await mj.startup?.promise;
        } catch {
          /* ignore */
        }
        engine = 'ready';
        push();
        return true;
      }
    }
    engine = 'missing';
    error = 'MathJax 未就绪（离线包与 CDN 均未提供 typesetPromise）';
    push();
    console.error('[MarkdownX] math engine unavailable:', error);
    return false;
  };

  const flush = async () => {
    flushTimer = null;
    if (destroyed || running || queue.size === 0) return;
    if (engine !== 'ready' && !(await waitForEngine())) return;
    if (destroyed) return;

    running = true;
    const batch = Array.from(queue);
    queue.clear();
    batch.forEach((el) => waiting.delete(el));
    push();
    const mj = getMathJax();
    try {
      // One call per batch: the wrapper resets global TeX state, so concurrent
      // calls would interleave their resets with queued typeset promises.
      mj?.typesetClear?.(batch);
      mj?.texReset?.();
      await mj?.typesetPromise?.(batch);
      typeset += batch.length;
      error = null;
      if (engine === 'error') engine = 'ready';
    } catch (err) {
      // Put the batch back so a later refresh can retry it.
      batch.forEach((el) => {
        if (el.isConnected && needsTypesetting(el)) queue.add(el);
      });
      engine = 'error';
      error = String(err);
      console.error('[MarkdownX] MathJax typesetting failed:', err);
    } finally {
      running = false;
      push();
      if (queue.size > 0) schedule();
    }
  };

  const schedule = () => {
    if (destroyed || flushTimer !== null) return;
    flushTimer = window.setTimeout(() => void flush(), BATCH_DELAY_MS);
  };

  const enqueue = (el: HTMLElement) => {
    waiting.delete(el);
    if (!needsTypesetting(el)) return;
    queue.add(el);
    schedule();
    push();
  };

  /** Fallback sweep for anything the observer may not have caught (cheap rect test). */
  const sweepNearViewport = () => {
    if (destroyed || waiting.size === 0) return;
    const height = window.innerHeight || 0;
    let moved = 0;
    for (const el of Array.from(waiting)) {
      if (!el.isConnected) {
        waiting.delete(el);
        continue;
      }
      if (!needsTypesetting(el)) {
        waiting.delete(el);
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= -1200 && rect.top <= height + 1200) {
        enqueue(el);
        moved += 1;
      }
    }
    if (moved > 0) push();
  };

  const scan = () => {
    if (destroyed) return;
    const containers = Array.from(root.querySelectorAll(MATH_SELECTOR)) as HTMLElement[];
    if (!containers.length) return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          observer?.unobserve(el);
          enqueue(el);
        }
      },
      { root: null, rootMargin: PRELOAD_MARGIN, threshold: 0 }
    );
    let observed = 0;
    for (const el of containers) {
      if (!needsTypesetting(el)) {
        waiting.delete(el);
        queue.delete(el);
        continue;
      }
      if (queue.has(el)) continue;
      observed += 1;
      // Already on screen (or close to it)? Queue immediately, otherwise observe
      // and let the scroll sweep / observer bring it in range later.
      const rect = el.getBoundingClientRect();
      const near =
        rect.bottom >= -1200 && rect.top <= (window.innerHeight || 0) + 1200;
      if (near) {
        enqueue(el);
      } else {
        waiting.add(el);
        observer.observe(el);
      }
    }
    if (observed === 0) {
      engine = engine === 'unknown' ? 'ready' : engine;
    }
    push();
  };

  const typesetAll = async () => {
    if (destroyed) return;
    const containers = Array.from(root.querySelectorAll(MATH_SELECTOR)).filter(
      needsTypesetting
    ) as HTMLElement[];
    containers.forEach((el) => {
      waiting.delete(el);
      queue.add(el);
    });
    observer?.disconnect();
    observer = null;
    await flush();
    // Anything the batch could not finish (e.g. the engine came up late) gets one
    // more chance, still inside a single engine call.
    if (queue.size > 0) await flush();
  };

  // Fallback: a throttled scroll sweep, so a viewport that the observer does not
  // report on (nested scrollers, programmatic jumps, restored positions) still gets
  // its formulas typeset.
  let scrollTimer: number | null = null;
  const onScroll = () => {
    if (destroyed || scrollTimer !== null) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = null;
      sweepNearViewport();
    }, 120);
  };
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });

  // First scan after the current frame so the browser has laid the chunks out.
  window.requestAnimationFrame(() => scan());

  return {
    refresh: () => scan(),
    typesetAll,
    destroy: () => {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      queue.clear();
      waiting.clear();
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      if (scrollTimer !== null) window.clearTimeout(scrollTimer);
      flushTimer = null;
      scrollTimer = null;
    }
  };
}