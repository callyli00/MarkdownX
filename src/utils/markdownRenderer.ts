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

  renderer.heading = function (textOrToken: any, level?: any, raw?: any): string {
    const isToken = typeof textOrToken === 'object' && textOrToken !== null;
    const text = isToken ? textOrToken.text : textOrToken;
    const hLevel = isToken ? textOrToken.depth : (level || 1);
    const rawText = isToken ? textOrToken.raw : (raw || text);
    const slug = encodeURIComponent(String(rawText || '').trim().toLowerCase().replace(/\s+/g, '-'));
    return `<h${hLevel} id="heading-${slug}" data-heading="${encodeURIComponent(String(rawText || '').trim())}">${text}</h${hLevel}>`;
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

function processMathAndCitations(rawMarkdown: string): { sanitizedMarkdown: string; tokens: TokenStore } {
  // Sanitize any stray ASCII control characters (such as backspace \x08) that can break LaTeX engines
  const cleanMarkdown = rawMarkdown.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const tokens: TokenStore = {};
  const labelToTagMap = new Map<string, string>();
  let tokenCounter = 0;
  let autoEqNumber = 1;

  // 1. Process Display Math: extract tags and labels
  let sanitized = cleanMarkdown.replace(/\$\$([\s\S]*?)\$\$/g, (_, rawMathContent) => {
    let math = rawMathContent.trim();
    
    // Check for explicit \tag{...}
    const tagMatch = math.match(/\\tag\{([^}]+)\}/);
    // Check for \label{...}
    const labelMatch = math.match(/\\label\{([^}]+)\}/);

    let assignedTag: string | undefined = undefined;
    if (tagMatch) {
      assignedTag = tagMatch[1].trim();
      math = math.replace(/\\tag\{[^}]+\}/g, '').trim();
    } else if (labelMatch) {
      assignedTag = String(autoEqNumber++);
    }

    let labelId: string | undefined = undefined;
    if (labelMatch) {
      const parsedId = labelMatch[1].trim();
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
    const label = rawLabel.trim();
    const tag = labelToTagMap.get(label) || labelToTagMap.get(label.replace(/^eq:/, '')) || '1';
    const cleanId = label.replace(/[^a-zA-Z0-9_-]/g, '-');
    
    if (cmd === 'eqref') {
      return `<a class="equation-ref-link" href="#eq-${cleanId}" title="跳转至公式 (${tag})">(${tag})</a>`;
    } else {
      return `<a class="equation-ref-link" href="#eq-${cleanId}" title="跳转至公式 ${tag}">${tag}</a>`;
    }
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

  return { sanitizedMarkdown: sanitized, tokens };
}

function detokenizeMath(html: string, tokens: TokenStore): string {
  let restoredHtml = html;

  for (const [key, item] of Object.entries(tokens)) {
    if (item.type === 'display') {
      const cleanId = item.labelId ? ` id="eq-${item.labelId.replace(/[^a-zA-Z0-9_-]/g, '-')}"` : '';
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
