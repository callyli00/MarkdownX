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

/**
 * Lift every ```mermaid fence out of the document BEFORE the math tokenizer
 * runs, because fenced blocks are masked verbatim and would otherwise reach the
 * reader as literal source. Returns an opaque sentinel per diagram plus the
 * diagram bodies keyed by index.
 */
function extractMermaidBlocks(input: string): {
  text: string;
  sources: string[];
} {
  const sources: string[] = [];
  const lines = input.split('\n');
  const out: string[] = [];
  let open = false;
  let buffer: string[] = [];
  let lang = '';
  let openLine = '';

  // `openLine` keeps the verbatim opening fence so an untagged block can be
  // re-emitted byte-identically if it turns out not to be a diagram.
  let pendingFence: { marker: string; openLine: string; body: string[] } | null = null;

  for (const line of lines) {
    if (!open && !pendingFence) {
      // The info string runs to end-of-line so metadata such as
      // ```mermaid title="..." is captured whole.
      const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (!m) {
        out.push(line);
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
        buffer = [];
        continue;
      }

      // No/unknown language tag: hold the fence briefly so the body can be
      // sniffed for a Mermaid declaration. Everything stays byte-identical, so
      // emitting it unchanged later is always safe.
      pendingFence = { marker, openLine: line, body: [] };
      continue;
    }

    if (open) {
      const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === lang[0] && close[1].length >= lang.length) {
        sources.push(buffer.join('\n'));
        out.push(`${MERMAID_PREFIX}${sources.length - 1}${MERMAID_SUFFIX}`);
        open = false;
        buffer = [];
      } else {
        buffer.push(line);
      }
      continue;
    }

    // Accumulating a pending untagged fence.
    const pending = pendingFence;
    if (!pending) continue;
    const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
    if (close && close[1][0] === pending.marker[0] && close[1].length >= pending.marker.length) {
      const body = pending.body.join('\n');
      if (looksLikeMermaid(body)) {
        sources.push(body);
        out.push(`${MERMAID_PREFIX}${sources.length - 1}${MERMAID_SUFFIX}`);
      } else {
        out.push(pending.openLine, ...pending.body, close[0]);
      }
      pendingFence = null;
      continue;
    }
    pending.body.push(line);
  }

  // Unterminated fence: NEVER guessed at, NEVER trimmed. The block is re-emitted
  // verbatim as a code sample (the closing marker is supplied so it cannot
  // swallow the remainder of the document) and followed by an explicit hint, so
  // the author sees exactly what was written and how to fix it.
  if (open) {
    out.push(openLine, ...buffer, lang, '', MERMAID_UNCLOSED);
  }
  if (pendingFence) {
    out.push(pendingFence.openLine, ...pendingFence.body, pendingFence.marker);
    if (looksLikeMermaid(pendingFence.body.join('\n'))) {
      out.push('', MERMAID_UNCLOSED);
    }
  }

  return { text: out.join('\n'), sources };
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

    let sourceUrl = href;
    const isRemote = /^https?:\/\//i.test(href) || href.startsWith('data:');
    
    if (!isRemote && href) {
      let resolvedPath = href;
      if (documentBasePath && !href.startsWith('/') && !/^[A-Za-z]:\\/.test(href) && !/^[A-Za-z]:\//.test(href)) {
        const separator = documentBasePath.includes('\\') ? '\\' : '/';
        const cleanHref = href.replace(/^\.\/|^\.\\/, '');
        resolvedPath = `${documentBasePath}${separator}${cleanHref}`;
      }
      try {
        sourceUrl = convertFileSrc(resolvedPath);
      } catch (err) {
        console.error('convertFileSrc error:', err);
        sourceUrl = href;
      }
    }

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

const PROTECT_PREFIX = '@@MDPROTECT';
const PROTECT_SUFFIX = '@@';

/**
 * Replace every region whose content must reach the reader byte-exact with an
 * opaque sentinel, so the math tokenizer can never rewrite LaTeX that lives
 * inside code samples or HTML comments. Sentinels contain no '$' or '\\', and
 * are restored with a replacer FUNCTION so '$$' inside the payload survives.
 */
function maskVerbatimRegions(input: string): { masked: string; store: Map<string, string> } {
  const store = new Map<string, string>();
  let counter = 0;
  const mask = (segment: string): string => {
    const key = `${PROTECT_PREFIX}${counter++}${PROTECT_SUFFIX}`;
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
} {
  // Sanitize any stray ASCII control characters (such as backspace \x08) that can break LaTeX engines
  const cleanMarkdown = rawMarkdown.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Diagrams leave the text flow first: fenced blocks are masked verbatim below,
  // so a ```mermaid block would otherwise be rendered as literal source.
  const { text: withoutDiagrams, sources: diagramSources } = extractMermaidBlocks(cleanMarkdown);

  // Mask code samples / HTML comments BEFORE any math rewriting happens.
  const { masked, store } = maskVerbatimRegions(withoutDiagrams);

  const tokens: TokenStore = {};
  const labelToTagMap = new Map<string, string>();
  let tokenCounter = 0;
  let autoEqNumber = 1;
  // Numbers already spoken for by a manual \\tag{...}: automatic numbering must
  // skip them, otherwise a hand-numbered (1) collides with an auto-numbered (1).
  const claimedNumbers = new Set<string>();

  // 1. Process Display Math: extract tags and labels
  let sanitized = masked.replace(/\$\$([\s\S]*?)\$\$/g, (_, rawMathContent) => {
    let math = rawMathContent.trim();
    
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
  });

  // 2. Process \eqref{...} and \ref{...} in prose (both bare or inside $...$)
  sanitized = sanitized.replace(/(?:\$)?\\(eqref|ref)\{([^}]+)\}(?:\$)?/g, (_, cmd, rawLabel) => {
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

  // 3. Extract remaining Inline Math ($...$)
  sanitized = sanitized.replace(/(?<!\\)\$((?:\\.|[^$])+?)\$/g, (_, inlineMath) => {
    const key = `@@MATH_INLINE_${tokenCounter++}@@`;
    tokens[key] = {
      type: 'inline',
      math: inlineMath
    };
    return key;
  });

  // Restore code samples / comments only after all math rewriting is finished,
  // so marked receives the author's original bytes.
  return {
    sanitizedMarkdown: unmaskVerbatimRegions(sanitized, store),
    tokens,
    diagramSources
  };
}

function detokenizeMath(html: string, tokens: TokenStore, diagramSources: string[]): string {
  // marked wraps a lone block sentinel in <p>; a <div> may not live inside a <p>,
  // so strip BOTH block-level wrappers before injecting any block markup.
  let restoredHtml = html.replace(
    /<p>(\s*)(@@MATH_DISPLAY_\d+@@|@@MERMAID\d+@@)(\s*)<\/p>/g,
    '$1$2$3'
  );

  // Replace each diagram sentinel with a container that mermaid.render() can
  // populate, plus a <pre> fallback so an error still shows readable source.
  diagramSources.forEach((source, index) => {
    const diagramHtml =
      `<div class="mermaid-diagram">` +
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
      const rowHtml = `<div class="math-equation-row"${cleanId}${texAttr}>` +
        `<div class="math-equation-content">$$${item.math}$$</div>` +
        `${tagHtml}` +
        `</div>`;
      
      // CRITICAL FIX: Use a function () => rowHtml.
      // In JS, passing a string with '$$' to String.prototype.replace treats '$$' as an escape for a single '$'.
      // Passing a function () => rowHtml guarantees '$$' and '$' are never swallowed or mangled.
      restoredHtml = restoredHtml.replace(key, () => rowHtml);
    } else {
      const inlineMathHtml = `<span class="math-inline">$${item.math}$</span>`;
      restoredHtml = restoredHtml.replace(key, () => inlineMathHtml);
    }
  }

  return restoredHtml;
}

export async function renderMarkdown(rawMarkdown: string, documentBasePath: string = ''): Promise<string> {
  configureMarked(documentBasePath);
  const { sanitizedMarkdown, tokens, diagramSources } = processMathAndCitations(rawMarkdown);
  const rawHtml = await marked.parse(sanitizedMarkdown);
  return detokenizeMath(rawHtml, tokens, diagramSources);
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
