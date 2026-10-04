/**
 * Incremental math typesetting (v2 stage 3, revised).
 *
 * The problem it solves
 * ---------------------
 * A formula-dense document freezes the window when the engine is asked to typeset
 * all of it in one call - and most of that work is wasted, because the reader never
 * looks at most of it. Measured on a real report: 174 formulas, one call, seconds of
 * frozen UI.
 *
 * Policy (what the user asked for): render what is being read, and let the rest
 * follow gently in the background, a little at a time.
 *
 *   - viewport first     anything near the viewport is handed to the engine before
 *                        anything else
 *   - small batches      at most MAX_BATCH containers per engine call, so no single
 *                        call can stall the window
 *   - background fill    while nothing visible is pending, a few more containers are
 *                        promoted per tick, in document order, until everything is done
 *   - never twice        a container that already holds rendered output is skipped
 *   - single-flight      one engine call at a time (the wrapper resets global TeX state)
 *   - loud on failure    a missing engine, or a call that renders nothing, is reported,
 *                        requeued and retried - never counted as success
 *
 * Visibility uses plain geometry (getBoundingClientRect against the viewport) rather
 * than IntersectionObserver: geometry is deterministic and cannot silently stop
 * reporting inside nested scrollers.
 */

export type MathEngineState = 'unknown' | 'loading' | 'ready' | 'missing' | 'error';

export interface MathTypesetStatus {
  engine: MathEngineState;
  /** Containers that now hold rendered output. */
  typeset: number;
  /** Containers still to do (queued for the next batch + waiting their turn). */
  pending: number;
  error: string | null;
}

export interface MathTypesetSession {
  /** Re-scan the root for containers that still need typesetting. */
  refresh(): void;
  /** Typeset everything remaining (export / print / explicit retry). */
  typesetAll(): Promise<void>;
  /** Stop all scheduling and drop queued work. */
  destroy(): void;
}

const MATH_SELECTOR = '.math-equation-row, .math-inline';
/** Containers this far outside the viewport are treated as "being read". */
const PRELOAD_PX = 1200;
/** Hard cap per engine call - the whole point is that one call stays cheap. */
const MAX_BATCH = 8;
/** Background cadence: how often more off-screen work is promoted. */
const FILL_INTERVAL_MS = 90;
/** How many containers the background fill promotes per tick. */
const FILL_PER_TICK = 4;
/** Engine readiness budget; the app's own loader has CDN fallbacks behind it. */
const ENGINE_WAIT_MS = 10000;
/** How long to wait before re-checking whether the engine has arrived. */
const RETRY_DELAY_MS = 1500;
/** Scroll settle time before the background fill resumes. */
const SCROLL_QUIET_MS = 220;

type MathJaxLike = {
  typesetPromise?: (elements?: HTMLElement[]) => Promise<void>;
  typesetClear?: (elements?: HTMLElement[]) => void;
  texReset?: () => void;
  startup?: { promise?: Promise<unknown> };
};

function getMathJax(): MathJaxLike | undefined {
  return (window as unknown as { MathJax?: MathJaxLike }).MathJax;
}

/** Needs typesetting = no rendered output inside yet. */
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

  /** Not yet rendered, in document order (rebuilt by every collect()). */
  let waiting: HTMLElement[] = [];
  /** The next batch to hand to the engine. */
  const queue = new Set<HTMLElement>();

  let pumpTimer: number | null = null;
  let fillTimer: number | null = null;
  let retryTimer: number | null = null;
  let lastScrollAt = 0;

  const pendingCount = () => waiting.length + queue.size;

  const push = () => {
    if (destroyed) return;
    onStatus({ engine, typeset, pending: pendingCount(), error });
  };

  const schedulePump = () => {
    if (destroyed || pumpTimer !== null) return;
    pumpTimer = window.setTimeout(() => {
      pumpTimer = null;
      void pump();
    }, 0);
  };

  const scheduleFill = () => {
    if (destroyed || fillTimer !== null) return;
    fillTimer = window.setTimeout(() => {
      fillTimer = null;
      // Respect the reader: do not spend background time while they are scrolling.
      if (Date.now() - lastScrollAt < SCROLL_QUIET_MS) {
        scheduleFill();
        return;
      }
      promoteVisible();
      if (!promoteBackground(FILL_PER_TICK)) return;
      schedulePump();
      scheduleFill();
    }, FILL_INTERVAL_MS);
  };

  /** Rebuild the pending list from the DOM (cheap; preserves document order). */
  const collect = () => {
    if (destroyed) return;
    const all = Array.from(root.querySelectorAll(MATH_SELECTOR)) as HTMLElement[];
    waiting = all.filter((el) => needsTypesetting(el) && !queue.has(el));
  };

  const nearViewport = (el: HTMLElement): boolean => {
    const rect = el.getBoundingClientRect();
    const height = window.innerHeight || 0;
    return rect.bottom >= -PRELOAD_PX && rect.top <= height + PRELOAD_PX;
  };

  /** Anything being read goes first. */
  const promoteVisible = () => {
    if (!waiting.length) return;
    const still: HTMLElement[] = [];
    let promoted = 0;
    for (const el of waiting) {
      if (!el.isConnected || !needsTypesetting(el)) continue;
      if (nearViewport(el)) {
        queue.add(el);
        promoted += 1;
      } else {
        still.push(el);
      }
    }
    if (promoted > 0) {
      waiting = still;
      push();
    }
  };

  /** Gentle off-screen progress, in document order. */
  const promoteBackground = (count: number): boolean => {
    let moved = 0;
    while (moved < count && waiting.length > 0) {
      const el = waiting.shift() as HTMLElement;
      if (!el.isConnected || !needsTypesetting(el)) continue;
      queue.add(el);
      moved += 1;
    }
    if (moved > 0) push();
    return moved > 0;
  };

  /**
   * A one-shot engine wait is not enough: MathJax may still be fetching its bundle
   * when the document opens, and then nothing would ever render until something
   * recreates the session (the "switch views and it works" workaround users hit).
   */
  const scheduleEngineRetry = () => {
    if (destroyed || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (destroyed) return;
      if (pendingCount() > 0 && engine !== 'ready') {
        promoteVisible();
        if (queue.size === 0) promoteBackground(FILL_PER_TICK);
        schedulePump();
      }
    }, RETRY_DELAY_MS);
  };

  const waitForEngine = async (): Promise<boolean> => {
    const existing = getMathJax();
    if (existing?.typesetPromise) {
      try {
        await existing.startup?.promise;
      } catch {
        /* a startup rejection is not fatal: typesetPromise may still work */
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

  /** Hand ONE capped batch to the engine and verify it actually produced output. */
  const runBatch = async (batch: HTMLElement[]): Promise<void> => {
    const requeue = () => {
      batch.forEach((el) => {
        if (el.isConnected && needsTypesetting(el)) queue.add(el);
      });
    };
    const mj = getMathJax();
    if (!mj?.typesetPromise) {
      // Guard: `await mj?.typesetPromise?.(batch)` would "succeed" with no engine at
      // all, drain the queue and report progress that never happened.
      requeue();
      engine = 'missing';
      error = 'MathJax 未就绪（离线包与 CDN 均未提供 typesetPromise）';
      push();
      console.error('[MarkdownX] math engine unavailable:', error);
      scheduleEngineRetry();
      return;
    }
    try {
      mj.typesetClear?.(batch);
      mj.texReset?.();
      await mj.typesetPromise(batch);
      const withContent = batch.filter((el) => (el.textContent || '').trim().length > 0);
      const rendered = withContent.filter((el) => el.isConnected && !needsTypesetting(el)).length;
      if (withContent.length > 0 && rendered === 0) {
        throw new Error(`引擎调用未产生渲染输出（0 / ${withContent.length} 个容器）`);
      }
      typeset += rendered;
      error = null;
      if (engine === 'error') engine = 'ready';
    } catch (err) {
      requeue();
      engine = 'error';
      error = String(err);
      console.error('[MarkdownX] MathJax typesetting failed:', err);
      scheduleEngineRetry();
    }
  };

  /**
   * One pump = one capped engine call. Visible work first; when nothing visible is
   * pending, the background fill keeps the document converging without ever issuing
   * a call large enough to freeze the window.
   */
  const pump = async () => {
    if (destroyed || running) return;
    promoteVisible();
    let batch = Array.from(queue);
    if (batch.length === 0) {
      if (promoteBackground(FILL_PER_TICK)) batch = Array.from(queue);
    }
    if (batch.length === 0) {
      if (pendingCount() > 0) scheduleEngineRetry();
      return;
    }
    batch = batch.slice(0, MAX_BATCH);
    batch.forEach((el) => queue.delete(el));
    running = true;
    push();
    const ready = engine === 'ready' || (await waitForEngine());
    if (destroyed) {
      running = false;
      return;
    }
    if (ready) {
      await runBatch(batch);
    } else {
      batch.forEach((el) => queue.add(el));
      scheduleEngineRetry();
    }
    running = false;
    push();
    if (pendingCount() > 0) {
      schedulePump();
      scheduleFill();
    }
  };

  const scan = () => {
    if (destroyed) return;
    collect();
    promoteVisible();
    if (pendingCount() > 0) {
      schedulePump();
      scheduleFill();
    } else if (engine === 'unknown') {
      engine = 'ready';
    }
    push();
  };

  const onScroll = () => {
    if (destroyed) return;
    lastScrollAt = Date.now();
    promoteVisible();
    if (queue.size > 0) schedulePump();
    push();
  };
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });

  // First pass after layout so the geometry test is meaningful.
  window.requestAnimationFrame(() => scan());

  return {
    refresh: () => scan(),
    typesetAll: async () => {
      if (destroyed) return;
      collect();
      // Force everything through, still in capped batches (print / export path).
      let guard = 0;
      while (!destroyed && pendingCount() > 0 && guard < 5000) {
        guard += 1;
        promoteBackground(MAX_BATCH);
        await pump();
      }
    },
    destroy: () => {
      destroyed = true;
      queue.clear();
      waiting = [];
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      for (const t of [pumpTimer, fillTimer, retryTimer]) {
        if (t !== null) window.clearTimeout(t);
      }
      pumpTimer = null;
      fillTimer = null;
      retryTimer = null;
    }
  };
}