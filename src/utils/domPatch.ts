/**
 * Minimal DOM patch planning for the preview.
 *
 * The preview used to re-create its whole subtree on every keystroke (React replaced the
 * article's innerHTML). That is correct but expensive: MathJax re-typesets every formula on
 * the page and the browser relayouts the entire document, which is exactly what makes editing
 * a long formula-heavy note feel sluggish.
 *
 * The compromise that keeps rendering semantics unchanged: still render the WHOLE document
 * (all cross-block passes - equation numbering, heading anchors, footnote placement - stay
 * intact), then replace only the top-level nodes whose HTML actually changed. Everything
 * outside the edited block keeps its identity, so its typeset math is untouched and the
 * scroll position stops jumping.
 *
 * This module is pure string work so the plan is unit-testable without a DOM; applying the
 * plan is a dozen lines in App.tsx.
 */
export interface PatchPlan {
  /** Number of leading children that are byte-identical and stay untouched. */
  prefix: number;
  /** Number of trailing children that are byte-identical and stay untouched. */
  suffix: number;
  /** Children to remove, starting at `prefix`. */
  removeCount: number;
  /** Serialized replacement children (may be empty). */
  insert: string[];
}

const EMPTY_PLAN: PatchPlan = { prefix: 0, suffix: 0, removeCount: 0, insert: [] };

/**
 * Compare two lists of serialized top-level nodes and return the smallest middle replacement.
 *
 * Prefix and suffix are computed independently and then clamped so they can never describe the
 * same node twice - a document made of identical paragraphs would otherwise claim everything is
 * both prefix and suffix, and the middle range would come out negative.
 */
export function planPatch(prev: string[], next: string[]): PatchPlan {
  const prevLen = prev.length;
  const nextLen = next.length;
  if (prevLen === 0 && nextLen === 0) return EMPTY_PLAN;

  let prefix = 0;
  while (prefix < prevLen && prefix < nextLen && prev[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < prevLen - prefix &&
    suffix < nextLen - prefix &&
    prev[prevLen - 1 - suffix] === next[nextLen - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    prefix,
    suffix,
    removeCount: prevLen - prefix - suffix,
    insert: next.slice(prefix, nextLen - suffix)
  };
}

/** True when the plan does nothing at all - skip DOM work, typesetting and mermaid redraws. */
export function isNoopPatch(plan: PatchPlan): boolean {
  return plan.removeCount === 0 && plan.insert.length === 0;
}

/**
 * True when everything is being replaced anyway (document opened, mode switched, first paint).
 * The host can then use its full-replace path, which also resets typeset state wholesale.
 */
export function isFullReplace(plan: PatchPlan, prevLen: number): boolean {
  return plan.prefix === 0 && plan.suffix === 0 && plan.removeCount === prevLen;
}
