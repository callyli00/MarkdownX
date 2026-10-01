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
    type: 'display' | 'inline';
    math: string;
    tag?: string;
    labelId?: string;
  };
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

function processMathAndCitations(rawMarkdown: string): { sanitizedMarkdown: string; tokens: TokenStore } {
  // Sanitize any stray ASCII control characters (such as backspace \x08) that can break LaTeX engines
  const cleanMarkdown = rawMarkdown.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Mask code samples / HTML comments BEFORE any math rewriting happens.
  const { masked, store } = maskVerbatimRegions(cleanMarkdown);

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
  return { sanitizedMarkdown: unmaskVerbatimRegions(sanitized, store), tokens };
}

function detokenizeMath(html: string, tokens: TokenStore): string {
  // marked wraps a lone block token in <p>; a <div> may not live inside a <p>,
  // so drop the paragraph wrapper BEFORE injecting the equation row.
  let restoredHtml = html.replace(/<p>(\s*)(@@MATH_DISPLAY_\d+@@)(\s*)<\/p>/g, '$1$2$3');

  for (const [key, item] of Object.entries(tokens)) {
    if (item.type === 'display') {
      const cleanId = item.labelId ? ` id="${labelToAnchorId(item.labelId)}"` : '';
      const tagHtml = item.tag ? `<span class="math-equation-tag">(${item.tag})</span>` : '';
      
      const rowHtml = `<div class="math-equation-row"${cleanId}>` +
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
  const { sanitizedMarkdown, tokens } = processMathAndCitations(rawMarkdown);
  const rawHtml = await marked.parse(sanitizedMarkdown);
  return detokenizeMath(rawHtml, tokens);
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
