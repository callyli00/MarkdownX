/**
 * Copying a selection that contains typeset formulas — the pure half.
 *
 * Why formulas vanish from a copy
 * -------------------------------
 * The default engine is SVG (`index.html` → `tex-svg.js`), so a typeset formula is
 *
 *     <mjx-container jax="SVG"><svg><g><use href="#MJX-…"/></g></svg>
 *       <mjx-assistive-mml>…</mjx-assistive-mml></mjx-container>
 *
 * Every glyph is a vector `<path>`: there is no text node to select, so a drag-select
 * runs straight past the formula. The one textual copy MathJax keeps (the assistive
 * MathML, for screen readers) is deliberately unusable for selection — MathJax injects
 * `mjx-assistive-mml { clip: rect(1px, 1px, 1px, 1px); user-select: none }`.
 * Switching to the CHTML engine does not help either (MathJax #2240: the glyphs are
 * `<mjx-c>` + web fonts, still no selectable characters).
 *
 * So `Selection.toString()` — and the browser's own Ctrl+C — silently drop formulas.
 * The renderer already keeps the truth: each math host carries its LaTeX in
 * `data-tex-source`. This module turns a DOM subtree back into text with that source
 * substituted in, which is the only faithful thing a copy can contain.
 *
 * Everything here is pure string/tree work on a duck-typed node, so it is unit-testable
 * in the Node test environment (this repo has no jsdom). The DOM half — cloning the
 * range, swapping hosts, asking the engine for laid-out text — lives in App.tsx.
 */

/** Attribute the renderer stamps on every math host (`.math-inline` / `.math-equation-row`). */
export const MATH_TEX_ATTR = 'data-tex-source';

/**
 * The parts of a DOM node this module touches.
 *
 * Structural subset of `Node`/`Element` so real DOM nodes can be passed as-is, while
 * the tests can hand over plain objects instead of building a DOM.
 */
export interface CopyTreeNode {
  readonly nodeType: number;
  readonly nodeValue?: string | null;
  readonly tagName?: string;
  readonly childNodes?: ArrayLike<CopyTreeNode> | null;
  getAttribute?(name: string): string | null;
  classList?: { contains(token: string): boolean };
}

/** One run of a copied selection: either literal text or one formula's source. */
export type CopyRun =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; display: boolean };

const TEXT_NODE = 3;

/** A math host's LaTeX source, or null when this node is not one. */
export function mathHostSource(node: CopyTreeNode): { tex: string; display: boolean } | null {
  if (typeof node.getAttribute !== 'function') return null;
  const tex = node.getAttribute(MATH_TEX_ATTR);
  if (!tex) return null;
  // Display rows are the `.math-equation-row` divs. `tagName` is the fallback so the
  // check still works on a node that exposes attributes but no classList.
  const display = node.classList
    ? node.classList.contains('math-equation-row')
    : String(node.tagName || '').toUpperCase() === 'DIV';
  return { tex, display };
}

function isTextNode(node: CopyTreeNode): boolean {
  return node.nodeType === TEXT_NODE;
}

function isLineBreak(node: CopyTreeNode): boolean {
  return node.nodeType === 1 && String(node.tagName || '').toUpperCase() === 'BR';
}

/**
 * Flatten a subtree into copy runs.
 *
 * A math host is emitted as ONE run and never descended into: its rendered children are
 * glyph paths plus the assistive MathML, neither of which belongs in a copy.
 */
export function flattenForCopy(root: CopyTreeNode): CopyRun[] {
  const runs: CopyRun[] = [];
  const visit = (node: CopyTreeNode): void => {
    if (isTextNode(node)) {
      runs.push({ kind: 'text', text: node.nodeValue ?? '' });
      return;
    }
    const math = mathHostSource(node);
    if (math) {
      runs.push({ kind: 'math', tex: math.tex, display: math.display });
      return;
    }
    if (isLineBreak(node)) {
      runs.push({ kind: 'text', text: '\n' });
      return;
    }
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i += 1) visit(children[i]);
  };
  visit(root);
  return runs;
}

/**
 * True when the subtree holds at least one formula.
 *
 * The copy handler uses this to decide whether to take the clipboard over at all: without
 * math the native copy is better (it keeps rich formatting), so it must be left alone.
 */
export function containsMath(root: CopyTreeNode): boolean {
  let found = false;
  const visit = (node: CopyTreeNode): void => {
    if (found) return;
    if (isTextNode(node)) return;
    if (mathHostSource(node)) {
      found = true;
      return;
    }
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length && !found; i += 1) visit(children[i]);
  };
  visit(root);
  return found;
}

/**
 * The delimiters this app's renderer accepts for math: `$…$` inline and `$$…$$` display
 * (see `processMathAndCitations` / the MathJax config in index.html).
 *
 * Display math is written on its own lines so that pasting it into Markdown yields a
 * block, not a formula glued to the end of the previous line.
 */
export function wrapTex(tex: string, display: boolean): string {
  const body = tex.trim();
  return display ? `$$\n${body}\n$$` : `$${body}$`;
}

/**
 * Plain-text fallback: runs → one string.
 *
 * Used when the engine will not give laid-out text (no `innerText`, or an empty probe).
 * Line structure is approximate here — block boundaries are lost — which is why the DOM
 * path prefers `innerText` and only falls back to this.
 */
export function assembleClipboardText(runs: CopyRun[]): string {
  let out = '';
  for (const run of runs) {
    if (run.kind === 'text') {
      out += run.text;
      continue;
    }
    if (run.display) {
      if (out && !out.endsWith('\n')) out += '\n';
      out += wrapTex(run.tex, run.display);
      out += '\n';
      continue;
    }
    out += wrapTex(run.tex, run.display);
  }
  return out;
}
