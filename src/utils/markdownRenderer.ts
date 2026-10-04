import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import cpp from 'highlight.js/lib/languages/cpp';
import fortran from 'highlight.js/lib/languages/fortran';
import json from 'highlight.js/lib/languages/json';
import { convertFileSrc } from '@tauri-apps/api/core';

hljs.registerLanguage('python', python);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('fortran', fortran);
hljs.registerLanguage('json', json);

interface TokenStore {
  [key: string]: {
    type: 'display' | 'inline' | 'mermaid';
    math: string;
    tag?: string;
    labelId?: string;
  };
}

const MERMAID_PREFIX = '@@MERMAID';
const MERMAID_SUFFIX = '@@';
// Appended when a diagram fence never closes. A missing closing fence usually
// means prose leaked into the body (a paste that dropped the terminator), so the
// block is shown verbatim as ordinary code instead of being guessed at: any
// attempt to trim the body could silently mangle valid Mermaid statements.
// Contains no backticks and no dollar signs so the verbatim masker and the math
// tokenizer pass it through untouched.
const MERMAID_UNCLOSED =
  '<div class="mermaid-unclosed-hint">⚠️ 检测到未闭合的 Mermaid 代码围栏（缺少结尾的 3 个反引号），已按普通代码块原样显示，不做任何裁剪。补上结尾标记后即可渲染为图表。</div>';

// Mermaid source is self-identifying: a diagram always begins with one of these
// declarations. Sniffing them lets an UNTAGGED fence (``` on its own line) still
// render as a diagram, which is how most users paste Mermaid from a chat box.
const MERMAID_DECLARATIONS = [
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap',
  'timeline', 'gitGraph', 'quadrantChart', 'requirementDiagram', 'C4Context',
  'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'kanban',
  'architecture-beta', 'radar-beta', 'treemap-beta'
];

/** True when the leading lines look like a Mermaid diagram declaration. */
function looksLikeMermaid(body: string): boolean {
  const meaningful = body
    .split('\n')
    .map((l) => l.trim())
    // '%%' introduces a Mermaid comment; '{%%' a directive fence.
    .filter((l) => l.length > 0 && !l.startsWith('%%'))
    .slice(0, 3);
  if (meaningful.length === 0) return false;
  const head = meaningful[0].split(/[\s:]/)[0].toLowerCase();
  // Compare case-insensitively: the declaration list is camelCase
  // (sequenceDiagram, classDiagram, gitGraph, ...) while `head` is lowercased,
  // so a plain includes() would silently reject every camelCase diagram type.
  return MERMAID_DECLARATIONS.some((d) => d.toLowerCase() === head);
}

/** Escape text for safe interpolation into an HTML text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface TranslationPiece { o: number; e: number; s: number; S: number }

/**
 * Exact offset translation from the reworked Markdown handed to marked back to
 * the author's bytes on disk. Every preprocessing pass reports its edits here,
 * so each rendered construct can carry the true source span it came from - the
 * anchor a deterministic click-to-source lookup needs (no text guessing).
 */
export class SourceTranslation {
  private pieces: TranslationPiece[];
  constructor(length: number) {
    this.pieces = [{ o: 0, e: length, s: 0, S: length }];
  }
  /** Original-source offset for a position in the current (reworked) text. */
  map(offset: number): number {
    const pieces = this.pieces;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pieces[mid].e <= offset) lo = mid + 1;
      else hi = mid;
    }
    const p = pieces[lo];
    if (!p) return offset;
    if (offset <= p.o) return p.s;
    if (offset >= p.e) return p.S;
    const span = p.e - p.o;
    if (span <= 0) return p.s;
    return p.s + Math.min(p.S - p.s, Math.round(((offset - p.o) / span) * (p.S - p.s)));
  }
  /** Record that [start, start+oldLength) became `newLength` characters that
   *  stand for the original range [srcStart, srcEnd). */
  replace(start: number, oldLength: number, newLength: number, srcStart: number, srcEnd: number): void {
    const end = start + oldLength;
    const delta = newLength - oldLength;
    const next: TranslationPiece[] = [];
    for (const p of this.pieces) {
      if (p.e <= start) { next.push(p); continue; }
      if (p.o >= end) { next.push({ o: p.o + delta, e: p.e + delta, s: p.s, S: p.S }); continue; }
      if (p.o < start) next.push({ o: p.o, e: start, s: p.s, S: Math.min(p.S, srcStart) });
      if (p.e > end) next.push({ o: end + delta, e: p.e + delta, s: Math.max(p.s, srcEnd), S: p.S });
    }
    next.push({ o: start, e: start + newLength, s: srcStart, S: srcEnd });
    next.sort((a, b) => a.o - b.o);
    this.pieces = next;
  }
}

/**
 * String.replace wrapper that reports every replacement to the translation.
 * Matches within one call are found in the pre-call text while earlier
 * replacements shift later positions, so the call tracks its own delta.
 */
function trackedReplace(
  text: string,
  translation: SourceTranslation,
  regex: RegExp,
  replacer: (...args: any[]) => string
): string {
  let delta = 0;
  return text.replace(regex, (...args: any[]) => {
    const offset = typeof args[args.length - 2] === 'number' ? (args[args.length - 2] as number) : 0;
    const match = String(args[0] ?? '');
    const replacement = replacer(...args);
    if (replacement.length !== match.length) {
      const at = offset + delta;
      translation.replace(at, match.length, replacement.length, translation.map(at), translation.map(at + match.length));
    }
    delta += replacement.length - match.length;
    return replacement;
  });
}

/**
 * Lift every ```mermaid fence out of the document BEFORE the math tokenizer
 * runs, because fenced blocks are masked verbatim and would otherwise reach the
 * reader as literal source. Returns an opaque sentinel per diagram plus the
 * diagram bodies keyed by index.
 */
interface MermaidEdit { inStart: number; inEnd: number; outLength: number }

function extractMermaidBlocks(input: string): {
  text: string;
  sources: string[];
  edits: MermaidEdit[];
} {
  const sources: string[] = [];
  const edits: MermaidEdit[] = [];
  const lines = input.split('\n');
  // Every emitted item remembers the input range it came from, so the lift can
  // be translated back to the author's bytes exactly.
  type Item = { text: string; src: [number, number] | null; sentinel?: boolean };
  const out: Item[] = [];
  const push = (text: string, src: [number, number] | null = null, sentinel = false) => {
    out.push(sentinel ? { text, src, sentinel } : { text, src });
  };
  let open = false;
  let buffer: Item[] = [];
  let lang = '';
  let openLine = '';
  let openStart = 0;

  // `openLine` keeps the verbatim opening fence so an untagged block can be
  // re-emitted byte-identically if it turns out not to be a diagram.
  let pendingFence: { marker: string; openLine: Item; body: Item[] } | null = null;

  let lineStart = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    const src: [number, number] = [lineStart, lineEnd];
    const prevStart = lineStart;
    lineStart = lineEnd + 1;

    if (!open && !pendingFence) {
      // The info string runs to end-of-line so metadata such as
      // ```mermaid title="..." is captured whole.
      const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (!m) {
        push(line, src);
        continue;
      }
      const marker = m[1];
      const info = m[2] || '';
      // The info string may carry metadata, e.g. ```mermaid title="流程".
      const infoHead = info.split(/\s+/)[0].toLowerCase();

      if (infoHead === 'mermaid') {
        open = true;
        lang = marker;
        openLine = line;
        openStart = prevStart;
        buffer = [];
        continue;
      }

      // No/unknown language tag: hold the fence briefly so the body can be
      // sniffed for a Mermaid declaration. Everything stays byte-identical, so
      // emitting it unchanged later is always safe.
      pendingFence = { marker, openLine: { text: line, src }, body: [] };
      continue;
    }

    if (open) {
      const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === lang[0] && close[1].length >= lang.length) {
        sources.push(buffer.map((b) => b.text).join('\n'));
        const key = `${MERMAID_PREFIX}${sources.length - 1}${MERMAID_SUFFIX}`;
        push(key, null, true);
        edits.push({ inStart: openStart, inEnd: lineEnd, outLength: key.length });
        open = false;
        buffer = [];
      } else {
        buffer.push({ text: line, src });
      }
      continue;
    }

    // Accumulating a pending untagged fence.
    const pending = pendingFence;
    if (!pending) continue;
    const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
    if (close && close[1][0] === pending.marker[0] && close[1].length >= pending.marker.length) {
      const body = pending.body.map((b) => b.text).join('\n');
      if (looksLikeMermaid(body)) {
        sources.push(body);
        const key = `${MERMAID_PREFIX}${sources.length - 1}${MERMAID_SUFFIX}`;
        push(key, null, true);
        edits.push({
          inStart: pending.openLine.src ? pending.openLine.src[0] : 0,
          inEnd: lineEnd,
          outLength: key.length
        });
      } else {
        push(pending.openLine.text, pending.openLine.src);
        for (const b of pending.body) push(b.text, b.src);
        push(close[0], src);
      }
      pendingFence = null;
      continue;
    }
    pending.body.push({ text: line, src });
  }

  // Unterminated fence: NEVER guessed at, NEVER trimmed. The block is re-emitted
  // verbatim as a code sample (the closing marker is supplied so it cannot
  // swallow the remainder of the document) and followed by an explicit hint, so
  // the author sees exactly what was written and how to fix it.
  if (open) {
    const anchor: [number, number] = [openStart, openStart];
    push(openLine, anchor);
    for (const b of buffer) push(b.text, b.src);
    push(lang, null);
    push('', null);
    push(MERMAID_UNCLOSED, null);
  }
  if (pendingFence) {
    push(pendingFence.openLine.text, pendingFence.openLine.src);
    for (const b of pendingFence.body) push(b.text, b.src);
    push(pendingFence.marker, null);
    if (looksLikeMermaid(pendingFence.body.map((b) => b.text).join('\n'))) {
      push('', null);
      push(MERMAID_UNCLOSED, null);
    }
  }

  // Synthesized output (supplied markers, hints) and each sentinel are paired
  // with the input range they stand for. Sentinels were recorded inline;
  // anything else without a counterpart anchors to the end of the preceding
  // ranged item.
  let lastSrcEnd = 0;
  for (const item of out) {
    if (item.src) {
      lastSrcEnd = item.src[1];
    } else if (!item.sentinel && item.text) {
      edits.push({ inStart: lastSrcEnd, inEnd: lastSrcEnd, outLength: item.text.length });
    }
  }
  edits.sort((a, b) => a.inStart - b.inStart || a.inEnd - b.inEnd);

  return { text: out.map((i) => i.text).join('\n'), sources, edits };
}

/**
 * Turn a document-relative asset reference into a loadable URL. Shared by the
 * Markdown image renderer and the raw-HTML <img> pass so both resolve
 * identically (a figure pasted as HTML must behave like one written as
 * Markdown).
 */
function resolveLocalAssetUrl(href: string, documentBasePath: string): string {
  const isRemote = /^https?:\/\//i.test(href) || href.startsWith('data:') || href.startsWith('asset:') || href.startsWith('blob:');
  if (isRemote || !href) return href;

  let resolvedPath = href;
  const isAbsolute =
    href.startsWith('/') || /^[A-Za-z]:[\\/]/.test(href);
  if (documentBasePath && !isAbsolute) {
    const separator = documentBasePath.includes('\\') ? '\\' : '/';
    const cleanHref = href.replace(/^\.\/|^\.\\/, '');
    resolvedPath = `${documentBasePath}${separator}${cleanHref}`;
  }
  try {
    return convertFileSrc(resolvedPath);
  } catch (err) {
    console.error('convertFileSrc error:', err);
    return href;
  }
}

/**
 * Raw HTML blocks (for example a <figure> pasted from a LaTeX PDF export or a
 * publisher's HTML) bypass the Markdown image renderer entirely, so their <img
 * src> would stay a bare relative path and never load inside the webview.
 * Rewrite those sources here.
 */
function resolveRawHtmlImageSources(html: string, documentBasePath: string): string {
  if (!documentBasePath) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i, (match, doubleQuoted, singleQuoted) => {
      const raw = (doubleQuoted ?? singleQuoted ?? '').trim();
      if (!raw) return match;
      const resolved = resolveLocalAssetUrl(raw, documentBasePath);
      if (resolved === raw) return match;
      const quote = doubleQuoted !== undefined ? '"' : "'";
      return `src=${quote}${resolved}${quote}`;
    })
  );
}

export function configureMarked(documentBasePath: string = ''): void {
  const renderer = new marked.Renderer();
  // Duplicate headings would otherwise share one id, making every outline entry
  // jump to the first occurrence. Suffix repeats with an occurrence counter.
  const headingIdCounts = new Map<string, number>();

  renderer.heading = function (textOrToken: any, level?: any, raw?: any): string {
    const isToken = typeof textOrToken === 'object' && textOrToken !== null;
    const text = isToken ? textOrToken.text : textOrToken;
    const hLevel = isToken ? textOrToken.depth : (level || 1);
    const rawText = isToken ? textOrToken.raw : (raw || text);
    const slug = encodeURIComponent(String(rawText || '').trim().toLowerCase().replace(/\s+/g, '-'));
    const seen = (headingIdCounts.get(slug) || 0) + 1;
    headingIdCounts.set(slug, seen);
    const uniqueSlug = seen > 1 ? `${slug}-${seen}` : slug;
    return `<h${hLevel} id="heading-${uniqueSlug}" data-heading="${encodeURIComponent(String(rawText || '').trim())}">${text}</h${hLevel}>`;
  };

  renderer.image = function (hrefOrToken: any, title?: any, text?: any): string {
    const isToken = typeof hrefOrToken === 'object' && hrefOrToken !== null;
    const href = (isToken ? hrefOrToken.href : hrefOrToken) || '';
    const imgTitle = (isToken ? hrefOrToken.title : title) || '';
    const altText = (isToken ? hrefOrToken.text : text) || '';

    const sourceUrl = resolveLocalAssetUrl(href, documentBasePath);

    const titleAttr = imgTitle ? ` title="${imgTitle}"` : '';
    return `<img src="${sourceUrl}" alt="${altText}"${titleAttr} class="rendered-image" />`;
  };

  renderer.code = function (codeOrToken: any, infostring?: any): string {
    const isToken = typeof codeOrToken === 'object' && codeOrToken !== null;
    const rawText = isToken ? codeOrToken.text : codeOrToken;
    const text = typeof rawText === 'string' ? rawText : '';
    const lang = (isToken ? codeOrToken.lang : infostring) || '';

    const validLanguage = lang && hljs.getLanguage(lang) ? lang : undefined;
    let highlighted: string;
    try {
      highlighted = validLanguage
        ? hljs.highlight(text, { language: validLanguage }).value
        : hljs.highlightAuto(text).value;
    } catch {
      highlighted = text;
    }

    const langDisplay = (lang || 'TEXT').toUpperCase();
    const encoded = encodeURIComponent(text);

    return `<div class="code-block-container">` +
      `<div class="code-block-header">` +
      `<span class="code-lang-pill">${langDisplay}</span>` +
      `<button class="code-copy-btn" data-code="${encoded}" onclick="window.__copyCodeBlock(this)">复制 (Copy)</button>` +
      `</div>` +
      `<pre><code class="hljs language-${lang || 'plaintext'}">${highlighted}</code></pre>` +
      `</div>`;
  };

  // Add Callout support for [!NOTE], [!TIP], [!WARNING], [!THEOREM], [!DEFINITION], [!ASSUMPTION]
  renderer.blockquote = function (tokenOrQuote: any): string {
    const isToken = typeof tokenOrQuote === 'object' && tokenOrQuote !== null;
    const rawHtml = isToken ? tokenOrQuote.text : tokenOrQuote;
    const content = typeof rawHtml === 'string' ? rawHtml : '';

    const match = content.match(/^\s*<p>\s*\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|THEOREM|DEFINITION|ASSUMPTION)\](?:\s*([^\n<]+))?/i);
    if (match) {
      const type = match[1].toLowerCase();
      const customTitle = match[2]?.trim() || '';
      const defaultTitles: Record<string, string> = {
        note: '注解 (Note)',
        tip: '提示 (Tip)',
        warning: '警告 (Warning)',
        caution: '注意 (Caution)',
        important: '重要 (Important)',
        theorem: '定理 (Theorem)',
        definition: '定义 (Definition)',
        assumption: '力学假定 (Assumption)',
      };
      const title = customTitle || defaultTitles[type] || type.toUpperCase();
      const cleanContent = content.replace(/^\s*<p>\s*\[![^\]]+\](?:[^\n<]+)?(?:\s*<br\s*\/?>)?/i, '<p>');
      return `<div class="callout-card callout-${type}"><div class="callout-header"><span class="callout-icon"></span><span class="callout-title">${title}</span></div><div class="callout-content">${cleanContent}</div></div>`;
    }

    return `<blockquote>${content}</blockquote>`;
  };

  marked.setOptions({
    renderer,
    gfm: true,
    breaks: false,
    pedantic: false
  });
}

/**
 * True when `index` sits inside an HTML tag (`<img ... >`), i.e. in attribute
 * space rather than in a text node.
 *
 * This matters because the math tokenizer runs on the raw Markdown, before any
 * HTML parsing, and it replaces `$..$` with a <span> element. Inside an
 * attribute that injected markup is catastrophic: `alt="... <span class="`
 * terminates the attribute early, the tag is shredded, and MathJax later dies
 * with "replaceChild of null" - taking every later equation down with it. Math
 * that lives in an attribute can never be typeset anyway (it is attribute text,
 * not a text node), so it must be left exactly as written.
 */
function isInsideHtmlTag(text: string, index: number): boolean {
  // A match at the very start cannot be inside anything. Without this guard,
  // lastIndexOf clamps its negative fromIndex to 0, finds the match's OWN '<'
  // and reports attribute space - silently skipping the first element of a
  // document (a leading display formula rendered as raw source).
  if (index <= 0) return false;
  const lastOpen = text.lastIndexOf('<', index - 1);
  if (lastOpen === -1) return false;
  const lastClose = text.lastIndexOf('>', index - 1);
  if (lastClose > lastOpen) return false;
  // Only a plausible tag opener counts, so "a < b and $x$" is not mistaken for
  // attribute space.
  const next = text[lastOpen + 1] || '';
  return next === '/' || next === '!' || next === '?' || /[A-Za-z]/.test(next);
}

/**
 * Replace every region whose content must reach the reader byte-exact with an
 * opaque sentinel, so the math tokenizer can never rewrite LaTeX that lives
 * inside code samples or HTML comments. Sentinels contain no '$' or '\\', and
 * are restored with a replacer FUNCTION so '$$' inside the payload survives.
 */
function maskVerbatimRegions(input: string): { masked: string; store: Map<string, string> } {
  const store = new Map<string, string>();
  let counter = 0;
  // Length-preserving sentinel: the mask is exactly as long as the region it
  // hides, so the mask/unmask round trip is transparent to the offset
  // translation and no position shifts while code is hidden. Control-char
  // delimiters cannot collide with maths syntax or with the stripped input
  // (stray control characters were removed before masking). Sub-4-char
  // segments - a one-character inline code - cannot contain a delimiter pair
  // the maths passes look for, so they are safely left unmasked.
  const mask = (segment: string): string => {
    if (segment.length < 4) return segment;
    const id = (counter++).toString(36);
    if (id.length > segment.length - 2) return segment;
    const key = `\u0001${id.padStart(segment.length - 2, '0')}\u0001`;
    store.set(key, segment);
    return key;
  };

  // 1. Fenced code blocks (``` or ~~~), scanned line-wise so nesting/mismatched
  //    fence lengths cannot desynchronise the mask.
  const lines = input.split('\n');
  const staged: string[] = [];
  let openFence: string | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    if (openFence === null) {
      const open = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (open) {
        openFence = open[1];
        buffer = [line];
        continue;
      }
      staged.push(line);
    } else {
      buffer.push(line);
      const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === openFence[0] && close[1].length >= openFence.length) {
        staged.push(mask(buffer.join('\n')));
        openFence = null;
        buffer = [];
      }
    }
  }
  if (openFence !== null) staged.push(mask(buffer.join('\n'))); // unterminated fence

  // 2. Indented code blocks. Per CommonMark an indented chunk can only start
  //    after a blank line, never as a lazy continuation of a paragraph — that
  //    guard keeps ordinary indented prose out of the mask.
  const isIndented = (l: string) => /^(?: {4,}|\t)/.test(l);
  let text = staged.join('\n');
  const outLines: string[] = [];
  let indBuf: string[] = [];
  const flushIndented = () => {
    if (indBuf.length) {
      outLines.push(mask(indBuf.join('\n')));
      indBuf = [];
    }
  };
  for (const line of text.split('\n')) {
    const prev = outLines.length ? outLines[outLines.length - 1] : '';
    const prevBlank = prev.trim() === '';
    if (isIndented(line) && (prevBlank || indBuf.length > 0)) {
      indBuf.push(line);
    } else {
      flushIndented();
      outLines.push(line);
    }
  }
  flushIndented();
  text = outLines.join('\n');

  // 3. HTML comments (including unterminated ones, which swallow to EOF).
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => mask(m));

  // 4. Inline code spans. Fenced blocks are already masked above, so a plain
  //    non-greedy backtick pair is safe here and cannot straddle a fence.
  text = text.replace(/(`+)([\s\S]*?)\1/g, (m) => mask(m));

  return { masked: text, store };
}

function unmaskVerbatimRegions(text: string, store: Map<string, string>): string {
  let restored = text;
  for (const [key, original] of store) {
    // MUST use a replacer function: a string replacement would interpret '$$'
    // inside LaTeX code samples as an escaped '$' and silently corrupt them.
    restored = restored.replace(key, () => original);
  }
  return restored;
}

/** Strip a leading 'eq:' prefix so '\eqref{a}' and '\eqref{eq:a}' address one label. */
function normalizeLabelKey(label: string): string {
  return label.trim().replace(/^eq:/, '');
}

/** Make a label safe for use inside an HTML id attribute. */
function labelToAnchorId(label: string): string {
  return `eq-${normalizeLabelKey(label).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function processMathAndCitations(rawMarkdown: string): {
  sanitizedMarkdown: string;
  tokens: TokenStore;
  diagramSources: string[];
  translation: SourceTranslation;
  tokenSourceSpans: Record<string, { start: number; end: number }>;
} {
  // Every rewriting pass reports its replacements here; the rendered HTML then
  // carries true source spans, and a click can be answered deterministically.
  const translation = new SourceTranslation(rawMarkdown.length);

  // Sanitize any stray ASCII control characters (such as backspace \x08) that can break LaTeX engines
  const cleanMarkdown = trackedReplace(rawMarkdown, translation, /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, () => '');

  // Diagrams leave the text flow first: fenced blocks are masked verbatim below,
  // so a ```mermaid block would otherwise be rendered as literal source.
  const { text: withoutDiagrams, sources: diagramSources, edits: mermaidEdits } = extractMermaidBlocks(cleanMarkdown);
  // Fold each lifted fence into the translation: its sentinel stands for the
  // whole fence, markers included.
  let mermaidDelta = 0;
  for (const mermaidEdit of mermaidEdits) {
    const at = mermaidEdit.inStart + mermaidDelta;
    const oldLength = mermaidEdit.inEnd - mermaidEdit.inStart;
    const srcA = translation.map(at);
    const srcB = translation.map(at + oldLength);
    translation.replace(at, oldLength, mermaidEdit.outLength, srcA, srcB);
    mermaidDelta += mermaidEdit.outLength - oldLength;
  }

  // Mask code samples / HTML comments BEFORE any math rewriting happens.
  const { masked, store } = maskVerbatimRegions(withoutDiagrams);

  const tokens: TokenStore = {};
  const labelToTagMap = new Map<string, string>();
  let tokenCounter = 0;
  let autoEqNumber = 1;
  // Numbers already spoken for by a manual \\tag{...}: automatic numbering must
  // skip them, otherwise a hand-numbered (1) collides with an auto-numbered (1).
  const claimedNumbers = new Set<string>();

  // 1. Process Display Math: extract tags and labels.
  //    '$$...$$' and the LaTeX-native '\\[...\\]' (emitted by publisher HTML and
  //    LaTeX exports) are both accepted; both are normalised to the same token.
  const displayDelimiters: [RegExp, RegExp] = [
    /\$\$([\s\S]*?)\$\$/g,
    /\\\[([\s\S]*?)\\\]/g
  ];

  const tokenizeDisplayMath = (match: string, rawMathContent: string, offset: number, whole: string): string => {
    // See isInsideHtmlTag: never rewrite math that lives in attribute space.
    if (isInsideHtmlTag(whole, offset)) return match;
    let math = rawMathContent.trim();

    // Guard for the \[...\] form only: escaped brackets are also how authors
    // write a literal citation such as [35]. Display math always carries a real
    // math signal (a command, superscript, subscript or relation), so require
    // one. Without this, '\[35\]' in prose would be centred as an equation -
    // the exact regression fixed back in v1.5.0.
    if (match.startsWith('\\[') && !/[\\^_=]/.test(math)) return match;
    
    // Check for explicit \\tag{...}
    const tagMatch = math.match(/\\tag\{([^}]+)\}/);
    // Check for \\label{...}
    const labelMatch = math.match(/\\label\{([^}]+)\}/);

    let assignedTag: string | undefined = undefined;
    if (tagMatch) {
      const explicitTag = tagMatch[1].trim();
      assignedTag = explicitTag;
      claimedNumbers.add(explicitTag);
      math = math.replace(/\\tag\{[^}]+\}/g, '').trim();
    } else if (labelMatch) {
      // Advance past every number a manual \\tag already claimed.
      while (claimedNumbers.has(String(autoEqNumber))) autoEqNumber++;
      const nextTag = String(autoEqNumber++);
      assignedTag = nextTag;
      claimedNumbers.add(nextTag);
    }

    let labelId: string | undefined = undefined;
    if (labelMatch) {
      const parsedId = normalizeLabelKey(labelMatch[1]);
      labelId = parsedId;
      math = math.replace(/\\label\{[^}]+\}/g, '').trim();
      if (assignedTag) {
        labelToTagMap.set(parsedId, assignedTag);
      }
    }

    const key = `@@MATH_DISPLAY_${tokenCounter++}@@`;
    tokens[key] = {
      type: 'display',
      math,
      tag: assignedTag,
      labelId
    };
    return key;
  };

  // 1. Publisher HTML wraps its maths in a dedicated span (or div):
  //    <span class="math math-inline">\boldsymbol{n}(\boldsymbol{r})</span>.
  //    The payload is BARE TeX - no $, no \( \) - so none of the delimiter
  //    passes below could ever match it and whole figure captions reached the
  //    reader as raw backslashes. Rewrite the wrapper into standard delimiters
  //    so every math notation is tokenized by the same machinery.
  const MATH_WRAPPER = /<(span|div)\b[^>]*\bclass\s*=\s*("[^"]*"|'[^']*')[^>]*>([\s\S]*?)<\/\1>/gi;
  let sanitized = trackedReplace(masked, translation, MATH_WRAPPER, (match: string, tagName: string, quotedClass: string, body: string, offset: number, whole: string): string => {
    // See isInsideHtmlTag: never rewrite math in attribute space.
    if (isInsideHtmlTag(whole, offset)) return match;
    const classes = String(quotedClass).slice(1, -1).trim().toLowerCase().split(/\s+/);
    // Only an exact 'math' class or a 'math-…' modifier marks maths; a utility
    // class such as 'mathtools' must not be caught by a loose prefix test.
    if (!classes.some((c) => c === 'math' || c.startsWith('math-'))) return match;
    let inner = String(body).trim();
    // The payload may carry its own delimiters (Pandoc keeps \(..\) inside its
    // 'math inline' spans); normalise them away before re-wrapping.
    const displayWrap = /^\$\$([\s\S]*?)\$\$$|^\\\[([\s\S]*?)\\\]$/.exec(inner);
    if (displayWrap) {
      inner = (displayWrap[1] ?? displayWrap[2] ?? '').trim();
    } else {
      const inlineWrap = /^\$([\s\S]*?)\$$|^\\\(([\s\S]*?)\\\)$/.exec(inner);
      if (inlineWrap) inner = (inlineWrap[1] ?? inlineWrap[2] ?? '').trim();
    }
    if (!inner) return match;
    const joined = classes.join(' ');
    const isDisplay =
      /\b(?:math-)?(?:display|block)\b/.test(joined) ||
      (String(tagName).toLowerCase() === 'div' && !/\binline\b/.test(joined));
    return isDisplay ? `$$${inner}$$` : `$${inner}$`;
  });

  // 2. Display delimiters: '$$...$$' and the LaTeX-native '\[...\]' - both the
  //    forms step 1 produced and the ones the author wrote directly.
  for (const delims of displayDelimiters) {
    sanitized = trackedReplace(sanitized, translation, delims, tokenizeDisplayMath as (...args: any[]) => string);
  }

  // 3. Process \eqref{...} and \ref{...} in prose (both bare or inside $...$)
  sanitized = trackedReplace(sanitized, translation, /(?:\$)?\\(eqref|ref)\{([^}]+)\}(?:\$)?/g, (_, cmd: string, rawLabel: string) => {
    const label = normalizeLabelKey(rawLabel);
    const anchorId = labelToAnchorId(label);
    const tag = labelToTagMap.get(label);

    if (tag === undefined) {
      // Unresolved label: flag it honestly instead of masquerading as equation (1).
      return `<span class="equation-ref-missing" title="未找到标签 {${rawLabel.trim()}}，请检查 \\label 定义">(?)</span>`;
    }

    if (cmd === 'eqref') {
      return `<a class="equation-ref-link" href="#${anchorId}" title="跳转至公式 (${tag})">(${tag})</a>`;
    }
    return `<a class="equation-ref-link" href="#${anchorId}" title="跳转至公式 ${tag}">${tag}</a>`;
  });

  // 4. Extract remaining Inline Math: '$...$' and the LaTeX-native '\\(...\\)'.
  //    Publisher HTML routinely uses the escaped-paren pair for inline math, so
  //    rejecting it left whole captions showing raw LaTeX.
  const tokenizeInlineMath = (match: string, inlineMath: string, offset: number, whole: string): string => {
    if (isInsideHtmlTag(whole, offset)) return match;
    const key = `@@MATH_INLINE_${tokenCounter++}@@`;
    tokens[key] = {
      type: 'inline',
      math: inlineMath
    };
    return key;
  };
  sanitized = trackedReplace(sanitized, translation, /(?<!\\)\$((?:\\.|[^$])+?)\$/g, tokenizeInlineMath);
  sanitized = trackedReplace(sanitized, translation, /(?<!\\)\\\(([\s\S]*?)\\\)/g, tokenizeInlineMath);

  // Restore code samples / comments only after all math rewriting is finished,
  // so marked receives the author's original bytes. Masks were length
  // preserving, so this round trip is transparent to the translation.
  const sanitizedMarkdown = unmaskVerbatimRegions(sanitized, store);

  // Anchor every sentinel to the source text it stands for: find it in the
  // final markdown, then translate through every recorded edit.
  const tokenSourceSpans: Record<string, { start: number; end: number }> = {};
  const anchor = (key: string) => {
    const at = sanitizedMarkdown.indexOf(key);
    if (at === -1) return;
    tokenSourceSpans[key] = { start: translation.map(at), end: translation.map(at + key.length) };
  };
  for (const key of Object.keys(tokens)) anchor(key);
  diagramSources.forEach((_, index) => anchor(`${MERMAID_PREFIX}${index}${MERMAID_SUFFIX}`));

  return { sanitizedMarkdown, tokens, diagramSources, translation, tokenSourceSpans };
}

function detokenizeMath(
  html: string,
  tokens: TokenStore,
  diagramSources: string[],
  tokenSourceSpans: Record<string, { start: number; end: number }>
): string {
  const srcAttr = (key: string): string => {
    const span = tokenSourceSpans[key];
    return span ? ` data-src-start="${span.start}" data-src-end="${span.end}"` : '';
  };

  // marked wraps a lone block sentinel in <p>; a <div> may not live inside a <p>,
  // so strip BOTH block-level wrappers before injecting any block markup. The
  // wrapper may now carry a source anchor, hence the attribute-tolerant match.
  let restoredHtml = html.replace(
    /<p(?:\s[^>]*)?>(\s*)(@@MATH_DISPLAY_\d+@@|@@MERMAID\d+@@)(\s*)<\/p>/g,
    '$1$2$3'
  );

  // Replace each diagram sentinel with a container that mermaid.render() can
  // populate, plus a <pre> fallback so an error still shows readable source.
  diagramSources.forEach((source, index) => {
    const diagramHtml =
      `<div class="mermaid-diagram"${srcAttr(`${MERMAID_PREFIX}${index}${MERMAID_SUFFIX}`)}>` +
      `<div class="mermaid-render-target" data-mermaid-source="${escapeHtml(source)}"></div>` +
      `<pre class="mermaid-fallback"><code class="language-mermaid">${escapeHtml(source)}</code></pre>` +
      `</div>`;
    restoredHtml = restoredHtml.replace(`${MERMAID_PREFIX}${index}${MERMAID_SUFFIX}`, () => diagramHtml);
  });

  for (const [key, item] of Object.entries(tokens)) {
    if (item.type === 'display') {
      const cleanId = item.labelId ? ` id="${labelToAnchorId(item.labelId)}"` : '';
      const tagHtml = item.tag ? `<span class="math-equation-tag">(${item.tag})</span>` : '';
      
      const texAttr = item.math ? ` data-tex-source="${escapeHtml(item.math)}"` : '';
      const rowHtml = `<div class="math-equation-row"${cleanId}${texAttr}${srcAttr(key)}>` +
        `<div class="math-equation-content">$$${item.math}$$</div>` +
        `${tagHtml}` +
        `</div>`;
      
      // CRITICAL FIX: Use a function () => rowHtml.
      // In JS, passing a string with '$$' to String.prototype.replace treats '$$' as an escape for a single '$'.
      // Passing a function () => rowHtml guarantees '$$' and '$' are never swallowed or mangled.
      restoredHtml = restoredHtml.replace(key, () => rowHtml);
    } else {
      // data-tex-source lets the preview->source mapper put the TeX back when it
      // probes a typeset formula (MathJax glyphs no longer match the source).
      const inlineTexAttr = item.math ? ` data-tex-source="${escapeHtml(item.math)}"` : '';
      const inlineMathHtml = `<span class="math-inline"${inlineTexAttr}${srcAttr(key)}>$${item.math}$</span>`;
      restoredHtml = restoredHtml.replace(key, () => inlineMathHtml);
    }
  }

  return restoredHtml;
}

/** One top-level block: the unit of chunked (v2) rendering. */
export interface MarkdownBlock {
  index: number;
  /** Raw markdown of this block, in the SANITIZED (math-masked) document. */
  raw: string;
  /** Offsets of this block in the ORIGINAL source - exactly what data-src-* carries. */
  srcStart: number;
  srcEnd: number;
  token: unknown;
}

/**
 * Everything that must be computed over the WHOLE document before any single
 * block can be rendered: the math/diagram token store, the offset translation,
 * and the cross-block registries (equation numbering, labels). Splitting here is
 * what lets the expensive per-block work run in slices, in a worker, or lazily.
 */
export interface PreparedDocument {
  blocks: MarkdownBlock[];
  tokens: TokenStore;
  diagramSources: string[];
  tokenSourceSpans: Record<string, { start: number; end: number }>;
  basePath: string;
}

/**
 * Phase 1 - document prepass. Whole-document work, done exactly once; every
 * per-block render afterwards is independent of document size.
 */
export function prepareDocument(rawMarkdown: string, documentBasePath: string = ''): PreparedDocument {
  configureMarked(documentBasePath);
  const { sanitizedMarkdown, tokens, diagramSources, translation, tokenSourceSpans } =
    processMathAndCitations(rawMarkdown);

  // Top-level tokens ARE the block boundaries - the same boundaries the
  // data-src-* anchors have always used, so the mapping contract is preserved.
  const lexed = marked.lexer(sanitizedMarkdown) as any[];
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  for (const token of lexed) {
    const raw = token && typeof token.raw === 'string' ? token.raw : '';
    const start = cursor;
    cursor += raw.length;
    blocks.push({
      index: blocks.length,
      raw,
      srcStart: translation.map(start),
      srcEnd: translation.map(start + raw.length),
      token
    });
  }
  return { blocks, tokens, diagramSources, tokenSourceSpans, basePath: documentBasePath };
}

/**
 * Phase 2 - render a contiguous block range (the indivisible unit of the
 * synchronous clone-free renderer API).
 *
 * Blocks MUST be rendered in ascending document order: heading id de-duplication
 * lives in the renderer's own state, so a suffix depends on how many identical
 * headings preceded this block. Chunked rendering keeps that order, which is why
 * the output is byte-identical to a single whole-document pass.
 */
export function renderBlockRange(prep: PreparedDocument, from = 0, to = prep.blocks.length): string {
  const parts: string[] = [];
  const end = Math.min(to, prep.blocks.length);
  for (let i = Math.max(0, from); i < end; i++) {
    const block = prep.blocks[i];
    let segment = String(marked.parser([block.token as any]));
    if (block.raw && block.srcEnd > block.srcStart) {
      segment = segment.replace(
        /^(\s*<[a-zA-Z][a-zA-Z0-9:-]*)/,
        `$1 data-src-start="${block.srcStart}" data-src-end="${block.srcEnd}"`
      );
    }
    parts.push(segment);
  }
  return parts.join('');
}

/**
 * Phase 3 - turn the assembled block HTML into final markup (token restoration,
 * then raw-HTML asset rewriting, which must run last).
 */
export function finalizeDocument(html: string, prep: PreparedDocument): string {
  return resolveRawHtmlImageSources(
    detokenizeMath(html, prep.tokens, prep.diagramSources, prep.tokenSourceSpans),
    prep.basePath
  );
}

export async function renderMarkdown(rawMarkdown: string, documentBasePath: string = ''): Promise<string> {
  const prep = prepareDocument(rawMarkdown, documentBasePath);
  return finalizeDocument(renderBlockRange(prep, 0, prep.blocks.length), prep);
}

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidInitPromise: Promise<void> | null = null;
let mermaidLoadPromise: Promise<MermaidApi | null> | null = null;
let mermaidInitialisedTheme: 'light' | 'dark' | 'sepia' | null = null;

/** Load the vendored offline bundle first, then fall back to a CDN. */
function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidLoadPromise) return mermaidLoadPromise;
  mermaidLoadPromise = new Promise<MermaidApi | null>((resolve) => {
    const globalMermaid = (window as unknown as { mermaid?: MermaidApi }).mermaid;
    if (globalMermaid) {
      resolve(globalMermaid);
      return;
    }
    const sources = ['./mermaid/mermaid.min.js', 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'];
    let index = 0;
    const tryNext = () => {
      if (index >= sources.length) {
        resolve(null);
        return;
      }
      const src = sources[index++];
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        const api = (window as unknown as { mermaid?: MermaidApi }).mermaid;
        resolve(api || null);
      };
      script.onerror = tryNext;
      document.head.appendChild(script);
    };
    tryNext();
  });
  return mermaidLoadPromise;
}

/**
 * Render every ```mermaid diagram inside `root`. Safe to call repeatedly: the
 * preview element is replaced wholesale on each keystroke, so each call sees a
 * fresh set of empty containers. Failures degrade to the visible source block.
 */
export async function renderMermaidDiagrams(root: HTMLElement | null, theme: 'light' | 'dark' | 'sepia' = 'light'): Promise<void> {
  if (!root) return;
  const targets = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-render-target'));
  if (targets.length === 0) return;

  const mermaid = await loadMermaid();
  if (!mermaid) {
    targets.forEach((el) => el.classList.add('mermaid-unavailable'));
    return;
  }

  if (!mermaidInitPromise || mermaidInitialisedTheme !== theme) {
    mermaidInitialisedTheme = theme;
    mermaidInitPromise = (async () => {
      mermaid.initialize({
        startOnLoad: false,
        // Offscreen staging root: mermaid measures text for auto-layout, and
        // rendering into a display:none container yields zero-size diagrams.
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-sans-active') || 'sans-serif',
        theme: theme === 'dark' ? 'dark' : theme === 'sepia' ? 'neutral' : 'default',
        securityLevel: 'strict',
        flowchart: { htmlLabels: false, useMaxWidth: true },
        sequence: { useMaxWidth: true },
        themeVariables: { fontFamily: 'inherit' }
      });
    })();
  }
  await mermaidInitPromise;

  for (const target of targets) {
    const host = target.closest('.mermaid-diagram');
    const fallback = host ? host.querySelector<HTMLElement>('.mermaid-fallback') : null;
    const diagramSource = target.getAttribute('data-mermaid-source') || '';
    if (!diagramSource.trim()) continue;

    const renderId = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const { svg } = await mermaid.render(renderId, diagramSource);
      target.innerHTML = svg;
      target.classList.add('mermaid-rendered');
      if (fallback) fallback.style.display = 'none';
    } catch (err) {
      console.warn('[Mermaid] render failed:', err);
      target.classList.add('mermaid-error');
      if (fallback) {
        fallback.style.display = '';
        target.insertAdjacentHTML(
          'afterend',
          `<div class="mermaid-error-note">图表语法错误，已显示源码：${escapeHtml(String((err as Error)?.message || err))}` +
          `<br>常见原因：围栏缺少结尾标记，导致正文被并入图表源码。</div>`
        );
      }
    }
  }
}

export async function triggerMathJax(targetElement: HTMLElement | null): Promise<void> {
  if (!targetElement) return;

  const getMj = () => (window as unknown as any).MathJax;

  // Critical fix for production build startup: wait if MathJax is still downloading/initializing
  if (!getMj()?.typesetPromise) {
    let waited = 0;
    while (!getMj()?.typesetPromise && waited < 6000) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      waited += 60;
    }
  }

  const globalMathJax = getMj();
  if (globalMathJax?.typesetPromise) {
    if (globalMathJax.startup?.promise) {
      try {
        await globalMathJax.startup.promise;
      } catch {}
    }

    try {
      if (globalMathJax.typesetClear) {
        globalMathJax.typesetClear([targetElement]);
      }
      if (typeof globalMathJax.texReset === 'function') {
        globalMathJax.texReset();
      }
      await globalMathJax.typesetPromise([targetElement]);
    } catch (err) {
      console.error('MathJax Typesetting Failed:', err);
    }
  }
}
