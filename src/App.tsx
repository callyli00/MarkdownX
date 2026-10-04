import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { prepareDocument, renderBlockRange, finalizeDocument, triggerMathJax, renderMermaidDiagrams } from './utils/markdownRenderer';
import { AppIcon } from './AppIcon';
import './App.css';

interface FileTab {
  id: string;
  name: string;
  path: string | null;
  content: string;
  isModified: boolean;
}

interface FileConflict {
  tabId: string;
  fileName: string;
  filePath: string;
  diskContent: string;
}

interface OutlineItem {
  level: number;
  title: string;
  line: number;
  slug: string;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}


type AppTheme = 'light' | 'dark' | 'sepia';
// 'auto' tracks the OS light/dark setting live (sepia never auto-selects:
// a paper tone is a deliberate taste, not a system signal).
type ThemePreference = 'auto' | AppTheme;

const THEME_OPTIONS: { id: ThemePreference; name: string; icon: string }[] = [
  { id: 'auto', name: '跟随系统 (Auto)', icon: '🖥️' },
  { id: 'light', name: '经典纯白学术 (Light)', icon: '☀️' },
  { id: 'dark', name: '夜间极客深色 (Dark)', icon: '🌙' },
  { id: 'sepia', name: '羊皮纸复古原木 (Sepia)', icon: '📜' }
];


/** Shown in the About dialog (version, build date, licence, recent notes). */
const APP_VERSION = 'v1.9.8';
const APP_BUILD_DATE = '2026-10-04';
const APP_LICENSE = 'MIT License';
const APP_TECH = 'Tauri v2 + Rust · React 18 + TypeScript · MathJax · Mermaid · highlight.js';
const RELEASE_NOTES: { version: string; date: string; items: string[] }[] = [
  {
    version: 'v1.9.8',
    date: '2026-10-04',
    items: [
      '修复 v1.9.7 回归：上半屏公式未排版（分片渲染在“首次挂载/从源码切回”时只排了最后一片）',
      '追加仍为增量排版；全新挂载整篇排一次，并加自愈兜底扫描'
    ]
  },
  {
    version: 'v1.9.7',
    date: '2026-10-04',
    items: [
      'v2 阶段二：分片渲染 —— 大文档首屏约 0.3s 出画，其余分片流式补齐，窗口不再冻结',
      '数学与图表按分片增量排版，旧分片 DOM 不被重建；状态栏显示排版进度',
      '渲染器拆为 prepass / 逐块渲染 / finalize，并以护栏保证分片与整篇渲染逐字节等价'
    ]
  },
  {
    version: 'v1.9.6',
    date: '2026-10-04',
    items: [
      '源码模式点击大纲：光标落在标题行首（可直接编辑 ## 前缀），且不选中任何内容'
    ]
  },
  {
    version: 'v1.9.5',
    date: '2026-10-04',
    items: [
      '顶栏 “?” 改为「关于」：展示版本号、本次更新、许可证与构建时间',
      '快捷键速查表统一收纳进 ⋯ 菜单 → 帮助',
      '源码模式点击大纲不再全选标题：仅定位光标并高亮该行'
    ]
  },
  {
    version: 'v1.9.4',
    date: '2026-10-04',
    items: [
      '修复最近文件子菜单的长路径溢出面板（改为省略号裁切）',
      '修复源码模式点击大纲不跳转（改用真实 caret 几何定位）'
    ]
  },
  {
    version: 'v1.9.3',
    date: '2026-10-04',
    items: ['修复二级菜单不向右弹出、菜单底部出现水平滚动条']
  },
  {
    version: 'v1.9.2',
    date: '2026-10-04',
    items: ['修复窗口三键失效（补齐 Tauri v2 窗口命令能力白名单）']
  }
];
const THEME_CYCLE: ThemePreference[] = ['auto', 'light', 'dark', 'sepia'];

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function resolveTheme(pref: ThemePreference): AppTheme {
  if (pref !== 'auto') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

interface TypographyConfig {
  latinFont: string;
  cjkFont: string;
  fontSize: number;
  lineHeight: number;
  paragraphMargin: number;
  textAlign: 'justify' | 'left';
  firstLineIndent: boolean;
  maxWidth: string;
}


const DEFAULT_TYPOGRAPHY: TypographyConfig = {
  latinFont: "'Times New Roman', Cambria",
  cjkFont: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', 'Source Han Serif SC'",
  fontSize: 16,
  lineHeight: 1.85,
  paragraphMargin: 1.25,
  textAlign: 'justify',
  firstLineIndent: false,
  maxWidth: '860px'
};

interface AppPreferences {
  defaultTheme: ThemePreference;
  defaultViewMode: 'typora' | 'source';
  defaultMathEngine?: 'svg' | 'chtml';
  autoWatchExternalChanges?: boolean;
  defaultTypography: TypographyConfig;
}

const FACTORY_PREFERENCES: AppPreferences = {
  defaultTheme: 'auto',
  defaultViewMode: 'typora',
  defaultMathEngine: 'svg',
  autoWatchExternalChanges: true,
  defaultTypography: DEFAULT_TYPOGRAPHY
};

function loadStoredPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem('markdownx_app_preferences_v140');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...FACTORY_PREFERENCES,
        ...parsed,
        defaultTypography: { ...FACTORY_PREFERENCES.defaultTypography, ...(parsed.defaultTypography || {}) }
      };
    }
    // Backward compatibility with previous versions
    const oldTheme = localStorage.getItem('preferred_app_theme') as AppTheme;
    const oldTypo = localStorage.getItem('preferred_typography_v3');
    if (oldTheme || oldTypo) {
      return {
        ...FACTORY_PREFERENCES,
        defaultTheme: (oldTheme === 'light' || oldTheme === 'dark' || oldTheme === 'sepia') ? oldTheme : 'auto',
        defaultTypography: oldTypo ? { ...DEFAULT_TYPOGRAPHY, ...JSON.parse(oldTypo) } : DEFAULT_TYPOGRAPHY
      };
    }
  } catch (err) {
    console.error('Failed to load stored preferences:', err);
  }
  return FACTORY_PREFERENCES;
}

const LATIN_FONT_OPTIONS = [
  { name: 'Times New Roman (经典学术期刊)', value: "'Times New Roman', Cambria" },
  { name: 'Cambria (现代自然衬线)', value: "Cambria, 'Times New Roman'" },
  { name: 'Georgia (典雅大方)', value: "Georgia, 'Times New Roman'" },
  { name: 'Garamond (人文教材专著)', value: "Garamond, Georgia, serif" },
  { name: 'Segoe UI / 苹方 (现代清晰无衬线)', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto" },
  { name: 'JetBrains Mono (工程算法等宽)', value: "'JetBrains Mono', Consolas, monospace" },
  { name: 'Fira Code (编程风格)', value: "'Fira Code', 'JetBrains Mono', monospace" }
];

const CJK_FONT_OPTIONS = [
  { name: '思源宋体 / SimSun (正文出版标准)', value: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', 'Source Han Serif SC'" },
  { name: '微软雅黑 / 苹方 (屏幕清晰黑体)', value: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC'" },
  { name: '楷体 (KaiTi - 典雅教材风格)', value: "'STKaiti', 'KaiTi', 'SimSun'" },
  { name: '仿宋 (FangSong - 规范工程报告)', value: "'STFangsong', 'FangSong', 'SimSun'" }
];

const MAX_WIDTH_OPTIONS = [
  { name: '窄版 (760px) - 专注单篇阅读', value: '760px' },
  { name: '标准版 (860px) - Typora 黄金阅读比例', value: '860px' },
  { name: '宽版 (1020px) - 适合大图与宽幅公式', value: '1020px' },
  { name: '超宽版 (1280px)', value: '1280px' },
  { name: '自适应全屏 (100%)', value: '100%' }
];



const MarkdownXLogo: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
  >
    <defs>
      <linearGradient id="mxGradLeft" x1="0%" y1="100%" x2="0%" y2="0%">
        <stop offset="0%" stopColor="#0284c7" />
        <stop offset="100%" stopColor="#38bdf8" />
      </linearGradient>
      <linearGradient id="mxGradRight" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#c084fc" />
        <stop offset="100%" stopColor="#7c3aed" />
      </linearGradient>
      <linearGradient id="mxGradCenter" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#38bdf8" />
        <stop offset="50%" stopColor="#6366f1" />
        <stop offset="100%" stopColor="#c084fc" />
      </linearGradient>
    </defs>
    {/* Dark rounded squircle background */}
    <rect x="4" y="4" width="92" height="92" rx="22" fill="#0f172a" stroke="#334155" strokeWidth="3" />
    {/* Artistic stylized M ribbon strokes */}
    {/* Left pillar */}
    <path d="M22 75 L22 34 L33 26 L33 75 Z" fill="url(#mxGradLeft)" />
    {/* Right pillar */}
    <path d="M67 75 L67 26 L78 34 L78 75 Z" fill="url(#mxGradRight)" />
    {/* Dynamic V arms */}
    <path d="M28 32 L50 62 L42 66 L22 38 Z" fill="#2563eb" />
    <path d="M72 32 L50 62 L58 66 L78 38 Z" fill="#9333ea" />
    {/* Center apex gemstone / X cross */}
    <polygon points="50,46 59,57 50,68 41,57" fill="#f43f5e" />
  </svg>
);

interface FileTreeNodeProps {
  item: FileEntry;
  level: number;
  activePath: string | null;
  expandedDirs: Record<string, boolean>;
  dirChildrenCache: Record<string, FileEntry[]>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  item,
  level,
  activePath,
  expandedDirs,
  dirChildrenCache,
  onToggleDir,
  onOpenFile,
}) => {
  const isExpanded = !!expandedDirs[item.path];
  const children = dirChildrenCache[item.path];

  if (item.is_dir) {
    return (
      <div className="file-tree-node-group">
        <div
          className={`file-tree-item is-dir level-${level}`}
          style={{ paddingLeft: `${level * 12 + 6}px` }}
          onClick={() => onToggleDir(item.path)}
          title={item.path}
        >
          <span className="tree-arrow">{isExpanded ? '▼' : '▶'}</span>
          <span className="file-icon">{isExpanded ? '📂' : '📁'}</span>
          <span className="file-title">{item.name}</span>
        </div>
        {isExpanded && (
          <div className="file-tree-children">
            {children === undefined ? (
              <div className="file-tree-loading" style={{ paddingLeft: `${(level + 1) * 12 + 16}px` }}>
                加载中...
              </div>
            ) : children.length === 0 ? (
              <div className="file-tree-empty-dir" style={{ paddingLeft: `${(level + 1) * 12 + 16}px` }}>
                (空文件夹)
              </div>
            ) : (
              children.map((child) => (
                <FileTreeNode
                  key={child.path}
                  item={child}
                  level={level + 1}
                  activePath={activePath}
                  expandedDirs={expandedDirs}
                  dirChildrenCache={dirChildrenCache}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`file-tree-item is-file level-${level} ${item.path === activePath ? 'active' : ''}`}
      style={{ paddingLeft: `${level * 12 + 20}px` }}
      onClick={() => onOpenFile(item.path)}
      title={item.path}
    >
      <span className="file-icon">📝</span>
      <span className="file-title">{item.name}</span>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Preview <-> source position mapping
 *
 * The preview is produced by marked, so a rendered node carries no link back
 * to the Markdown it came from. Both directions of the Typora-style mode
 * switch therefore work by folding the two representations down to a form that
 * can be compared - whitespace and Markdown syntax removed - and searching for
 * one inside the other.
 * ------------------------------------------------------------------ */

/** Characters that mark up the source but never survive into rendered text. */
const MATCH_NOISE = /[#*_`>|[\]()!~\\=+\-$]/;

/** One folded character, or '' when the character never survives into text. */
function foldChar(ch: string): string {
  if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\u00A0') return '';
  if (MATCH_NOISE.test(ch)) return '';
  return ch.toLowerCase();
}

/** Fold a string for comparison: drop whitespace and Markdown syntax, lower-case. */
export function foldForMatch(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += foldChar(text[i]);
  return out;
}

interface SourceIndex {
  /** Source with whitespace and Markdown syntax removed, lower-cased. */
  folded: string;
  /** Original character offset of each character in `folded`. */
  offsets: number[];
}

/** Yield to the browser: an idle callback when available, else a macrotask. */
function scheduleIdle(fn: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === 'function') ric(fn, { timeout: 120 });
  else window.setTimeout(fn, 0);
}

/** Time budget per rendering slice (ms). Keeps the UI responsive between slices. */
const RENDER_SLICE_MS = 12;
/** The first slice is the one the user actually waits for - keep it short. */
const FIRST_PAINT_MS = 16;

export function buildSourceIndex(content: string): SourceIndex {
  const chars: string[] = [];
  const offsets: number[] = [];

  // HTML tags are markup, never visible text - and an attribute often repeats
  // text that also renders (an img alt restates the caption below it), which
  // used to capture lookups meant for the visible copy. Fold the document line
  // by line, skipping tag interiors; fenced code is exempt because there a
  // literal '<div>' IS content.
  const lines = content.split('\n');
  let base = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) inFence = !inFence;
    let i = 0;
    while (i < line.length) {
      if (!inFence && line[i] === '<') {
        const tag = /^<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>/.exec(line.slice(i));
        if (tag) {
          i += tag[0].length;
          continue;
        }
      }
      const folded = foldForMatch(line[i]);
      if (folded) {
        chars.push(folded);
        offsets.push(base + i);
      }
      i++;
    }
    base += line.length + 1;
  }
  return { folded: chars.join(''), offsets };
}

// The index is rebuilt on every lookup, so cache it against the current text.
let cachedIndex: { key: string; value: SourceIndex } | null = null;

function getSourceIndex(content: string): SourceIndex {
  if (cachedIndex && cachedIndex.key === content) return cachedIndex.value;
  const value = buildSourceIndex(content);
  cachedIndex = { key: content, value };
  return value;
}

/**
 * Character offset in the source where the given rendered text begins, or null
 * when it cannot be located. Progressively shorter prefixes are tried so that a
 * block whose tail renders differently still resolves.
 */
export function locateRenderedText(index: SourceIndex, text: string, hint = 0): number | null {
  const needle = foldForMatch(text);
  if (needle.length < 4) return null;
  const from = Math.max(0, Math.min(hint, index.folded.length));

  // Try the full prefix first, then progressively shorter ones. The coarse
  // decrement keeps long blocks cheap, but it must always end with the short
  // prefixes too: a table or callout renders its inline math and its caption in
  // a different shape than the source, so only a short leading fragment (e.g.
  // the visible cell text) will match - a step that jumps from 10 straight past
  // 4 would skip exactly those.
  const lengths: number[] = [];
  const step = Math.max(1, Math.floor(needle.length / 8));
  for (let len = needle.length; len >= 24; len -= step) lengths.push(len);
  for (const len of [24, 16, 12, 8, 6, 4]) {
    if (len < needle.length && !lengths.includes(len)) lengths.push(len);
  }
  if (!lengths.includes(needle.length)) lengths.unshift(needle.length);

  for (const len of lengths) {
    const probe = needle.slice(0, len);
    // Prefer a hit at/after the hint: an identical sentence earlier in the
    // document must not capture a click that happened further down.
    const near = index.folded.indexOf(probe, from);
    if (near !== -1) return index.offsets[near];
    const anywhere = index.folded.indexOf(probe);
    if (anywhere !== -1) return index.offsets[anywhere];
  }
  return null;
}

/**
 * The text a rendered block should be matched against. Decorative chrome that
 * has no counterpart in the source is dropped, and blocks whose visible form is
 * generated (typeset math, rendered diagrams) contribute their original source.
 */
/**
 * Resolve an element inside the rendered preview to a character offset in the
 * Markdown source. Walks outward from the clicked node so that a click on an
 * inline <code>/<strong>/<svg> resolves through its enclosing block; the
 * outermost block that still matches wins.
 */
export function sourceOffsetForElement(
  start: HTMLElement,
  source: string,
  root: HTMLElement | null,
  point?: { x: number; y: number }
): number | null {
  // 1) Deterministic anchors (v1.8.5): the block's TRUE source span is stamped
  //    on the element. Read it, then refine to the clicked character inside
  //    that block's own slice - a bounded alignment, not a document search.
  const anchor = anchorRangeOf(start, root);
  if (anchor) {
    // A click on the artwork itself lands on the <img> tag, not the caption.
    const img = start.closest('img');
    if (img && anchor.el.contains(img)) {
      const imgAt = source.indexOf('<img', anchor.start);
      if (imgAt !== -1 && (anchor.end <= anchor.start || imgAt < anchor.end)) return imgAt;
    }
    const refined = refineWithinAnchor(anchor.el, source, anchor.start, anchor.end, point);
    return refined ?? anchor.start;
  }

  // 2) Legacy fallback for renders without anchors (older HTML, exotic blocks):
  //    fold-and-search, innermost block first.
  const index = getSourceIndex(source);
  let node: HTMLElement | null = start;

  // Walk outward and take the FIRST block that resolves: the innermost match is
  // the most faithful answer to "where did I click". A click on a table cell
  // therefore lands on that row rather than on the table header, while a click
  // on a cell whose rendered text cannot be found (typeset math, chromeless
  // chrome) still falls through to the enclosing row, list or paragraph.
  while (node && node !== root) {
    // TABLE and the list wrappers matter: clicking a table's own padding (or a
    // <ul> gutter) must still resolve, not fall through to the article. FIGURE
    // and FIGCAPTION matter for the same reason: a book page is mostly figures,
    // and a caption click used to walk past both and resolve to nothing.
    if (/^(P|H1|H2|H3|H4|H5|H6|LI|TD|TH|TR|TABLE|THEAD|TBODY|TFOOT|CAPTION|PRE|BLOCKQUOTE|UL|OL|DL|DT|DD|DIV|SECTION|ARTICLE|FIGURE|FIGCAPTION|ASIDE|HEADER|FOOTER|MAIN|NAV|DETAILS|SUMMARY|ADDRESS|HGROUP)$/.test(node.tagName)) {
      const probe = probeTextOf(node);
      if (probe.trim()) {
        const found = locateRenderedText(index, probe, 0);
        if (found !== null) {
          // The artwork itself: land on the <img> tag, not on the caption below.
          // Only a raw-HTML figure is written literally in the source; a
          // Markdown image has none, so restricting the search to figures
          // keeps a stray '<img' elsewhere from capturing the click.
          const img = start.closest('img');
          if (img && img.closest('figure') && node.contains(img)) {
            const tagAt = source.lastIndexOf('<img', found);
            if (tagAt !== -1 && found - tagAt < 4000) return tagAt;
          }
          // Otherwise narrow the block down to the text actually double-clicked.
          const refined = point ? refineOffsetAtPoint(index, found, point.x, point.y) : null;
          return refined ?? found;
        }
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Deterministic click-to-source resolution (v1.8.5). The renderer stamps every
 * top-level block - and every generated formula or diagram - with the TRUE
 * source span it was built from (data-src-start / data-src-end). A click reads
 * the anchor of its innermost enclosing block and, within that block, aligns
 * the clicked character against the block's own source slice. No global text
 * search is involved, so repeated paragraphs and duplicate captions cannot
 * deflect the answer.
 */
function anchorRangeOf(el: HTMLElement, root: HTMLElement | null): { el: HTMLElement; start: number; end: number } | null {
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    const attr = node.getAttribute('data-src-start');
    if (attr !== null) {
      const start = Number(attr);
      const endAttr = Number(node.getAttribute('data-src-end'));
      if (Number.isFinite(start) && start >= 0) {
        return { el: node, start, end: Number.isFinite(endAttr) && endAttr >= start ? endAttr : start };
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Measure where the caret at `pos` actually sits inside a textarea, in CONTENT
 * coordinates (padding included, scroll excluded). A mirror div replicating the
 * textarea's box carries the text up to `pos` plus a zero-width marker, so the
 * answer is correct even when long paragraphs wrap - logical-line arithmetic
 * silently drifts the moment one line folds onto two.
 */
export function measureTextareaCaret(
  ta: HTMLTextAreaElement,
  pos: number
): { top: number; caretLeft: number; height: number } {
  const cs = window.getComputedStyle(ta);
  const mirror = document.createElement('div');
  const copied = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
  ];
  for (const prop of copied) {
    (mirror.style as unknown as Record<string, string>)[prop] = cs.getPropertyValue(
      prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    );
  }
  mirror.style.position = 'absolute';
  mirror.style.left = '-10000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.boxSizing = cs.boxSizing || 'border-box';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = cs.wordBreak || 'break-word';
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = ta.value.slice(0, Math.max(0, Math.min(pos, ta.value.length)));
  const marker = document.createElement('span');
  marker.textContent = '\u200B';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const fallbackLineHeight = parseFloat(cs.lineHeight);
  const height = Number.isFinite(fallbackLineHeight) && fallbackLineHeight > 0
    ? fallbackLineHeight
    : marker.offsetHeight || 24;
  // The inline marker reports its own glyph box, not the full line box; lift
  // the result by the half-leading so the band covers the visual line exactly.
  const halfLeading = Math.max(0, (height - (marker.offsetHeight || height)) / 2);
  const result = { top: marker.offsetTop - halfLeading, caretLeft: marker.offsetLeft, height };
  document.body.removeChild(mirror);
  return result;
}

/** The first anchor inside `el` (used for the reverse direction). */
function firstAnchorIn(el: HTMLElement): { start: number; end: number } | null {
  const holder = el.matches('[data-src-start]') ? el : (el.querySelector('[data-src-start]') as HTMLElement | null);
  if (!holder) return null;
  const start = Number(holder.getAttribute('data-src-start'));
  if (!Number.isFinite(start) || start < 0) return null;
  const endAttr = Number(holder.getAttribute('data-src-end'));
  return { start, end: Number.isFinite(endAttr) && endAttr >= start ? endAttr : start };
}

/** Fold a source slice, skipping HTML tag interiors (never visible text). */
function foldSourceRange(source: string, start: number, end: number, skipTags: boolean): { folded: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  const stop = Math.min(source.length, Math.max(start, end));
  let i = Math.max(0, start);
  while (i < stop) {
    const ch = source[i];
    if (skipTags && ch === '<' && /[A-Za-z/!?]/.test(source[i + 1] || '')) {
      const close = source.indexOf('>', i);
      if (close !== -1 && close - i < 4000) {
        i = close + 1;
        continue;
      }
    }
    const f = foldChar(ch);
    if (f) {
      chars.push(f);
      map.push(i);
    }
    i++;
  }
  return { folded: chars.join(''), map };
}

function foldWithMap(text: string): { folded: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldChar(text[i]);
    if (f) {
      chars.push(f);
      map.push(i);
    }
  }
  return { folded: chars.join(''), map };
}

/** Count of folded characters at raw positions strictly before `limit`. */
function foldCountBefore(map: number[], limit: number): number {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Rendered text of a block with generated chrome removed and every typeset
 * formula replaced by the TeX it was built from, plus the position of the
 * clicked character inside that text.
 */
function buildBlockText(block: HTMLElement, click: { node: Node; offset: number } | null): { text: string; clickAt: number } {
  let out = '';
  let clickAt = -1;
  const checkClick = (node: Node, extra: number) => {
    if (click && (click.node === node || (node.nodeType === Node.ELEMENT_NODE && node.contains(click.node)))) {
      clickAt = out.length + extra;
    }
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      checkClick(node, Math.min(Math.max(click ? click.offset : 0, 0), text.length));
      out += text;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') return;
    if (el.classList.contains('code-block-header') || el.classList.contains('math-equation-tag')) return;
    if (el.classList.contains('mermaid-unclosed-hint') || el.classList.contains('mermaid-error-note')) return;
    if (el.style && el.style.display === 'none') return;
    const tex = el.getAttribute('data-tex-source');
    if (tex !== null && (el.classList.contains('math-inline') || el.classList.contains('math-equation-row'))) {
      checkClick(el, 1);
      out += tex;
      return;
    }
    const diagramSource = el.getAttribute('data-mermaid-source');
    if (diagramSource !== null) {
      checkClick(el, 0);
      out += diagramSource;
      return;
    }
    for (const child of Array.from(el.childNodes)) visit(child);
  };
  for (const child of Array.from(block.childNodes)) visit(child);
  return { text: out, clickAt };
}

/**
 * Greedy fold-space alignment: walk both folded strings; on a mismatch skip
 * whichever side's next occurrence of the other's character lies nearer. The
 * source side carries markup the rendered side never shows, and the rendered
 * side carries generated chrome, so both skip directions are needed. Returns
 * the source fold index for each processed rendered fold index (-1 = unmapped).
 */
function alignFolded(foldedRendered: string, foldedSource: string): Int32Array {
  const map = new Int32Array(foldedRendered.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < foldedRendered.length && j < foldedSource.length) {
    if (foldedRendered[i] === foldedSource[j]) {
      map[i] = j;
      i++;
      j++;
      continue;
    }
    const nextInSource = foldedSource.indexOf(foldedRendered[i], j);
    const nextInRendered = foldedRendered.indexOf(foldedSource[j], i);
    if (nextInSource === -1 && nextInRendered === -1) break;
    if (nextInRendered === -1 || (nextInSource !== -1 && nextInSource - j <= nextInRendered - i)) {
      j = nextInSource;
    } else {
      i = nextInRendered;
    }
  }
  return map;
}

/** The click position (text node + offset) inside `block`, if determinable. */
function locateClickIn(block: HTMLElement, point: { x: number; y: number } | undefined): { node: Node; offset: number } | null {
  try {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (block.contains(range.startContainer) && range.startContainer.nodeType === Node.TEXT_NODE) {
        return { node: range.startContainer, offset: range.startOffset };
      }
    }
  } catch {
    /* fall through to the point */
  }
  if (!point) return null;
  const caretFromPoint = (document as Document & {
    caretRangeFromPoint?: (cx: number, cy: number) => Range | null;
  }).caretRangeFromPoint;
  if (!caretFromPoint) return null;
  try {
    const range = caretFromPoint.call(document, point.x, point.y);
    if (range && block.contains(range.startContainer)) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Map the clicked character inside an anchored block to its exact source
 * offset, aligning folded rendered text against the block's own source slice.
 * Returns null when no reliable alignment exists; the caller then falls back
 * to the block start, which is still exact at block granularity.
 */
function refineWithinAnchor(
  block: HTMLElement,
  source: string,
  start: number,
  end: number,
  point?: { x: number; y: number }
): number | null {
  const click = locateClickIn(block, point);
  if (!click) return null;
  const built = buildBlockText(block, click);
  if (built.clickAt < 0) return null;
  const skipTags = !block.classList.contains('code-block-container');
  const sourceFold = foldSourceRange(source, start, end, skipTags);
  if (!sourceFold.folded.length) return null;
  const renderedFold = foldWithMap(built.text);
  if (!renderedFold.folded.length) return null;
  const aligned = alignFolded(renderedFold.folded, sourceFold.folded);
  const clickFold = foldCountBefore(renderedFold.map, built.clickAt);
  // The caret sits before the character the user pointed at, so map THAT
  // character; walk back only when it has no aligned counterpart.
  for (let k = Math.min(clickFold, aligned.length - 1); k >= 0; k--) {
    const j = aligned[k];
    if (j >= 0 && j < sourceFold.map.length) return sourceFold.map[j];
  }
  return null;
}

/**
 * Narrow a resolved block down to the text at a double-click point. The block
 * start is a coarse answer for a long paragraph; when the browser can tell us
 * which character the click landed on, locate that neighbourhood instead. A
 * failed or ambiguous refinement falls back to the block offset.
 */
function refineOffsetAtPoint(index: SourceIndex, blockOffset: number, x: number, y: number): number | null {
  const caretFromPoint = (document as Document & {
    caretRangeFromPoint?: (cx: number, cy: number) => Range | null;
  }).caretRangeFromPoint;
  if (!caretFromPoint) return null;
  let range: Range | null = null;
  try {
    range = caretFromPoint.call(document, x, y);
  } catch {
    return null;
  }
  if (!range) return null;
  const node: Node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent || '';
  const at = Math.min(Math.max(range.startOffset, 0), text.length);
  const windowText = text.slice(Math.max(0, at - 40), Math.min(text.length, at + 20));
  const windowFold = foldForMatch(windowText);
  if (windowFold.length < 4) return null;
  const found = locateRenderedText(index, windowText, blockOffset);
  if (found === null) return null;
  // Accept the refinement only when the WHOLE window matched there; otherwise
  // locateRenderedText fell back to a short prefix and the answer is a guess.
  const foldedAt = index.offsets.indexOf(found);
  if (foldedAt === -1 || !index.folded.startsWith(windowFold, foldedAt)) return null;
  return found;
}

/** The first child element of `root` whose rendered content matches `offset` or earlier. */
export function blockForSourceOffset(root: HTMLElement, source: string, offset: number): HTMLElement | null {
  const index = getSourceIndex(source);
  let cursor = 0;
  let target: HTMLElement | null = null;
  for (const el of Array.from(root.children) as HTMLElement[]) {
    const anchor = firstAnchorIn(el);
    let at: number | null = anchor ? anchor.start : null;
    if (at === null) {
      const probe = probeTextOf(el);
      if (!probe.trim()) continue;
      at = locateRenderedText(index, probe, cursor);
      if (at === null) continue;
    }
    cursor = Math.max(cursor, at);
    if (at <= offset) target = el;
    else break; // children are in document order
  }
  return target;
}

export function probeTextOf(el: HTMLElement): string {
  const mathRow = el.closest('.math-equation-row');
  if (mathRow) return mathRow.getAttribute('data-tex-source') || '';
  // The unclosed-fence notice is generated UI with no source counterpart.
  // Resolve it to the fence it annotates, so clicking it opens that code.
  const hint = el.closest('.mermaid-unclosed-hint');
  if (hint) {
    const prev = hint.previousElementSibling as HTMLElement | null;
    if (prev) return probeTextOf(prev);
  }
  const diagram = el.closest('.mermaid-diagram');
  if (diagram) {
    const src = diagram.querySelector('.mermaid-render-target')?.getAttribute('data-mermaid-source');
    if (src) return src;
  }
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.code-block-header, .math-equation-tag, .equation-ref-missing').forEach((n) => n.remove());
  // MathJax replaces a formula's TeX with rendered glyphs, which no longer
  // match the source; swap each formula back for the TeX it was built from so
  // probes keep lining up with the Markdown.
  clone.querySelectorAll('.math-inline[data-tex-source]').forEach((n) => {
    n.textContent = n.getAttribute('data-tex-source') || '';
  });
  return clone.textContent || '';
}

export const App: React.FC = () => {
  // Initial user preferences & defaults (initialized first before states depending on it)
  const initialPrefs = useRef<AppPreferences>(loadStoredPreferences());

  // Manage multiple open files in dropdown list - Pure Blank Document on Startup
  const [openFiles, setOpenFiles] = useState<FileTab[]>([
    {
      id: 'default-tab',
      name: '未命名文档.md',
      path: null,
      content: '', // 启动默认纯白空白文档
      isModified: false
    }
  ]);
  const [activeFileId, setActiveFileId] = useState<string>('default-tab');
  
  // Recent files history
  const [recentFiles, setRecentFiles] = useState<{ name: string; path: string }[]>([]);

  // Mode: false for Typora WYSIWYG/Preview mode (default), true for Source mode
  const [isSourceMode, setIsSourceMode] = useState<boolean>(() => initialPrefs.current.defaultViewMode === 'source');

  // Where the source caret just landed, painted as a short-lived highlight so
  // the writer can actually see the jump target instead of hunting for it.
  const [caretFlash, setCaretFlash] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    tickLeft: number;
  } | null>(null);
  // The line's position in CONTENT coordinates, so the highlight can stay glued
  // to it if the writer scrolls while it is still fading.
  const flashAnchorRef = useRef<{ paneTop: number; contentTop: number } | null>(null);

  // Caret offset to apply when the source view opens, and the position to
  // reveal again when the preview comes back (Typora-style continuity). The
  // restore also records the tab and the exact Markdown it was measured
  // against, so it can never scroll a differently-rendered document.
  const pendingSourceCaretRef = useRef<number | null>(null);
  const pendingPreviewScrollRef = useRef<{ tabId: string; content: string; offset: number } | null>(null);
  
  // Active dropdown menu: null | 'file' | 'edit' | 'format' | 'view' | 'fileList'
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  // Theme state: light | dark | sepia (initialized from user default)
  const [themePref, setThemePref] = useState<ThemePreference>(() => initialPrefs.current.defaultTheme);
  // The resolved theme (what the CSS and exporters actually see).
  const [appTheme, setAppTheme] = useState<AppTheme>(() => resolveTheme(initialPrefs.current.defaultTheme));
  const [defaultThemeSetting, setDefaultThemeSetting] = useState<ThemePreference>(() => initialPrefs.current.defaultTheme);
  const [defaultModeSetting, setDefaultModeSetting] = useState<'typora' | 'source'>(() => initialPrefs.current.defaultViewMode);
  const [defaultMathEngineSetting, setDefaultMathEngineSetting] = useState<'svg' | 'chtml'>(() => initialPrefs.current.defaultMathEngine || 'svg');
  const [autoWatchSetting, setAutoWatchSetting] = useState<boolean>(() => initialPrefs.current.autoWatchExternalChanges !== false);
  const [externalReloadNotice, setExternalReloadNotice] = useState<string | null>(null);
  // Workbench chrome: the right-hand typography inspector, the collapsed
  // outline groups, and which sidebar panel is shown.
  const [isInspectorOpen, setIsInspectorOpen] = useState<boolean>(false);
  // The OS title bar is disabled (decorations: false), so the caption buttons are
  // drawn in the top bar. The maximize / restore glyph has to follow the REAL
  // window state, which changes on resize, double-click and Aero Snap alike.
  const [isWindowMaximized, setIsWindowMaximized] = useState<boolean>(false);
  // Surfaced in the top bar if a window command is refused (e.g. a missing
  // capability) so a dead control is never silent again.
  const [windowCmdNotice, setWindowCmdNotice] = useState<string | null>(null);
  const [collapsedOutline, setCollapsedOutline] = useState<Set<number>>(new Set());
  // External-modification conflicts are tracked PER TAB so that background
  // documents keep their conflict state until the user resolves it explicitly.
  const [fileConflicts, setFileConflicts] = useState<Record<string, FileConflict>>({});

  const lastSelfSaveTimeRef = useRef<number>(0);
  const lastHandledTimeRef = useRef<number>(0);
  const activeFileIdRef = useRef<string>(activeFileId);
  // Always-fresh mirror of openFiles for async callbacks (React state updaters
  // must stay pure: StrictMode may invoke them twice and discard results).
  const openFilesRef = useRef<FileTab[]>(openFiles);
  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const clearFileConflict = useCallback((tabId: string) => {
    setFileConflicts((prev) => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  // Status notice banner inside modal
  const [modalFeedback, setModalFeedback] = useState<string | null>(null);

  // --- View & Sidebar States (Typora Complete Spec) ---
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [sidebarPanel, setSidebarPanel] = useState<'workspace' | 'search'>('workspace');
  const [outlineRegionOpen, setOutlineRegionOpen] = useState<boolean>(true);
  const [isFocusMode, setIsFocusMode] = useState<boolean>(false);
  const [isTypewriterMode, setIsTypewriterMode] = useState<boolean>(false);
  const [showStatusBar, setShowStatusBar] = useState<boolean>(true);
  const [showWordCountModal, setShowWordCountModal] = useState<boolean>(false);
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false);
  const [showMathHelpModal, setShowMathHelpModal] = useState<boolean>(false);
  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);

  // File tree / workspace directory
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [dirChildrenCache, setDirChildrenCache] = useState<Record<string, FileEntry[]>>({});
  const dirChildrenCacheRef = useRef<Record<string, FileEntry[]>>({});

  // Toggle directory expansion and asynchronously load n-level subdirectories
  const handleToggleDirectory = useCallback(async (dirPath: string) => {
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));

    // I/O stays OUTSIDE the state updater: read the cache through its ref mirror
    if (dirChildrenCacheRef.current[dirPath]) return;
    try {
      const children = await invoke<FileEntry[]>('read_dir_files', { dirPath });
      dirChildrenCacheRef.current = { ...dirChildrenCacheRef.current, [dirPath]: children };
      setDirChildrenCache((c) => ({ ...c, [dirPath]: children }));
    } catch (err) {
      console.error('Failed to read subdirectory:', dirPath, err);
    }
  }, []);

  // Search & Replace state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [replaceQuery, setReplaceQuery] = useState<string>('');
  const [searchMatchesCount, setSearchMatchesCount] = useState<number>(0);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The resolved theme drives the body class (all body.theme-* rules hang off it).
  useEffect(() => {
    document.body.className = `theme-${appTheme}`;
  }, [appTheme]);

  useEffect(() => {
    if (!windowCmdNotice) return;
    const t = window.setTimeout(() => setWindowCmdNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [windowCmdNotice]);

  // Preference -> resolved theme. Under 'auto' this follows the OS now and keeps
  // following it while the app is open (media-query listener).
  useEffect(() => {
    const apply = () => setAppTheme(resolveTheme(themePref));
    apply();
    // 'auto' must react while the app is open, not only at start-up.
    let mq: MediaQueryList | null = null;
    const onChange = () => apply();
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else mq.addListener(onChange);
    } catch {}
    return () => {
      try {
        if (mq) {
          if (mq.removeEventListener) mq.removeEventListener('change', onChange);
          else mq.removeListener(onChange);
        }
      } catch {}
    };
  }, [themePref]);

  // Global code block copy callback
  useEffect(() => {
    (window as any).__copyCodeBlock = (btn: HTMLButtonElement) => {
      const text = decodeURIComponent(btn.getAttribute('data-code') || '');
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.innerText;
        btn.innerText = '已复制 ✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerText = originalText;
          btn.classList.remove('copied');
        }, 1800);
      });
    };
  }, []);

  // Detailed Typography Configuration
  const [typography, setTypography] = useState<TypographyConfig>(() => {
    return initialPrefs.current.defaultTypography || DEFAULT_TYPOGRAPHY;
  });

  const [showTypographyModal, setShowTypographyModal] = useState<boolean>(false);
  // The settings modal holds two different natures of content. Each menu entry
  // promises one of them, so the opener picks which half is shown: live
  // document typography, or program-level startup preferences.
  const [settingsModalView, setSettingsModalView] = useState<'typography' | 'preferences'>('typography');
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Apply typography variables to document root
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--font-serif-active', `${typography.latinFont}, ${typography.cjkFont}, serif`);
    root.style.setProperty('--doc-font-size', `${typography.fontSize}px`);
    root.style.setProperty('--doc-line-height', String(typography.lineHeight));
    root.style.setProperty('--doc-p-margin', `${typography.paragraphMargin}em`);
    root.style.setProperty('--doc-text-align', typography.textAlign);
    root.style.setProperty('--doc-text-indent', typography.firstLineIndent ? '2em' : '0');
    root.style.setProperty('--doc-max-width', typography.maxWidth);

    localStorage.setItem('preferred_typography_v3', JSON.stringify(typography));
  }, [typography]);

  // v2 chunked rendering: the preview is a LIST of rendered slices rather than one
  // HTML blob, so appending the next slice touches only the new subtree (previously
  // every render destroyed and rebuilt the whole document).
  const [renderChunks, setRenderChunks] = useState<string[]>([]);
  const [renderProgress, setRenderProgress] = useState<{ done: number; total: number } | null>(null);
  const renderGenRef = useRef(0);
  const chunksRef = useRef<string[]>([]);
  const renderDoneRef = useRef<boolean>(true);
  const previewRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // The Markdown revision the current chunk set was produced from (rendering is async, so
  // a position restore must wait until this matches the current document.
  const renderedForContentRef = useRef<string | null>(null);

  const activeFile = openFiles.find((f) => f.id === activeFileId) || openFiles[0];

  // Banner for the active tab only: conflicts of background tabs stay stored
  // in fileConflicts and appear as soon as that tab becomes active again.
  const conflictBanner = fileConflicts[activeFileId] || null;

  const getBasePath = (fullPath: string | null): string => {
    if (!fullPath) return '';
    const index = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
    return index !== -1 ? fullPath.substring(0, index) : '';
  };

  /**
   * Chunked render (v2). The block boundaries ARE marked's top-level tokens, so a
   * slice is a contiguous block range; the first slice is published synchronously
   * so the window paints immediately, the rest is appended in idle slices (each
   * ending when its 12ms budget is spent). A generation counter voids in-flight
   * slices the moment the file changes again.
   *
   * Equivalence to a whole-document render is proven by tools/chunked-render-gate.
   */
  const updatePreview = useCallback(async (content: string, currentPath: string | null) => {
    const gen = renderGenRef.current + 1;
    renderGenRef.current = gen;
    renderDoneRef.current = false;
    const basePath = getBasePath(currentPath);
    try {
      const tPrep = performance.now();
      const prep = prepareDocument(content, basePath);
      const prepMs = performance.now() - tPrep;
      if (gen !== renderGenRef.current) return;
      renderedForContentRef.current = content;
      const total = prep.blocks.length;

      const publish = (html: string, next: number) => {
        chunksRef.current = [...chunksRef.current, html];
        setRenderChunks(chunksRef.current);
        setRenderProgress(next < total ? { done: next, total } : null);
      };

      // Render whole blocks until the budget is spent (always at least one block).
      const renderSlice = (from: number, budget: number, maxBlocks = Infinity) => {
        const started = performance.now();
        let i = from;
        let parts = '';
        while (i < total) {
          parts += renderBlockRange(prep, i, i + 1);
          i += 1;
          if (i - from >= maxBlocks) break;
          if (performance.now() - started >= budget) break;
        }
        const html = finalizeDocument(parts, prep);
        return { html, next: i, blocks: i - from, ms: performance.now() - started };
      };

      chunksRef.current = [];
      const first = renderSlice(0, FIRST_PAINT_MS);
      publish(first.html, first.next);
      console.log(`[MarkdownX] open: prepass ${prepMs.toFixed(1)}ms, first paint ${first.ms.toFixed(1)}ms ` +
                  `(${first.next}/${total} blocks, ${content.length} chars)`);
      if (first.next >= total) {
        renderDoneRef.current = true;
        return;
      }

      let cursor = first.next;
      // The finalize pass runs outside the block loop, so a slice's real cost
      // exceeds the budget it measured. Feed that overshoot back as a quota
      // correction - otherwise slices jank badly (measured ~40ms against a 12ms
      // budget on a 1.4MB document).
      let quota = Math.max(1, first.next);
      const pump = () => {
        if (gen !== renderGenRef.current) return;
        const slice = renderSlice(cursor, RENDER_SLICE_MS, quota);
        cursor = slice.next;
        publish(slice.html, cursor);
        if (cursor >= total) {
          renderDoneRef.current = true;
          return;
        }
        const scale = slice.ms > 0 ? RENDER_SLICE_MS / slice.ms : 1;
        quota = Math.min(Math.max(1, Math.round(slice.blocks * scale)), Math.max(1, slice.blocks * 2));
        scheduleIdle(pump);
      };
      scheduleIdle(pump);
    } catch (error) {
      console.error('Markdown rendering error:', error);
      const errHtml = `<div style="color: #ef4444; padding: 20px;">Rendering Error: ${String(error)}</div>`;
      chunksRef.current = [errHtml];
      setRenderChunks([errHtml]);
      setRenderProgress(null);
      renderDoneRef.current = true;
    }
  }, []);

  /** Exports need the finished document; a chunked render may still be running. */
  const awaitRenderedHtml = useCallback(async (): Promise<string> => {
    const started = Date.now();
    while (!renderDoneRef.current && Date.now() - started < 20000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return chunksRef.current.join('');
  }, []);

  // Update preview on tab change
  useEffect(() => {
    if (activeFile) {
      updatePreview(activeFile.content, activeFile.path);
    }
  }, [activeFile?.id, activeFile?.path, updatePreview]);

  // 300ms debounce when typing in source mode
  const handleContentChange = (newContent: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.id === activeFileId ? { ...f, content: newContent, isModified: true } : f))
    );

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      updatePreview(newContent, activeFile?.path || null);
    }, 300);
  };

  // Right-click policy. WebView2 (the Chromium engine under the app) shows its
  // own browser context menu - 返回/刷新/另存为/打印/检查 - on right-click
  // ANYWHERE by default. That menu is out of place in a desktop editor, and its
  // 刷新 entry would reload the whole app and risk unsaved edits, so it is
  // suppressed across the UI. The one exception is real editable fields, where
  // the native 剪切/复制/粘贴 (and spellcheck) menu is genuinely useful.
  // Also auto-cleans any corrupted MathJax menu state from earlier versions.
  useEffect(() => {
    try {
      localStorage.removeItem('mjx.menu');
      localStorage.removeItem('MathJax-Menu-Settings');
    } catch {}

    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const editable = target && target.closest('textarea, input, [contenteditable="true"]');
      if (!editable) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('contextmenu', handleContextMenu, true);
    return () => window.removeEventListener('contextmenu', handleContextMenu, true);
  }, []);

  /**
   * Typeset + draw the chunks that need it.
   *
   * Two cases must be distinguished, and conflating them is how a preview can show
   * raw TeX: a plain APPEND only needs the new tail (re-running the engine over the
   * whole article per append is quadratic), but a FRESH MOUNT - the first mount, or
   * coming back from the source view - means every chunk lost its typeset DOM, so
   * all of them must be processed again.
   */
  const previewMountRef = useRef(false);
  useEffect(() => {
    if (isSourceMode) {
      previewMountRef.current = false;
      return;
    }
    const root = previewRef.current;
    if (!root) return;
    const chunks = Array.from(root.querySelectorAll('.render-chunk')) as HTMLElement[];
    if (!chunks.length) return;
    const freshMount = !previewMountRef.current;
    previewMountRef.current = true;
    // ONE engine call per pass: triggerMathJax() runs a global texReset() before
    // typesetting, so issuing several calls concurrently lets those resets
    // interleave with the queued typeset promises.
    if (freshMount) {
      triggerMathJax(root);
      renderMermaidDiagrams(root, appTheme);
    } else {
      const last = chunks[chunks.length - 1];
      triggerMathJax(last);
      renderMermaidDiagrams(last, appTheme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderChunks.length, isSourceMode]);

  // Safety net: once the document has finished streaming, typeset any chunk that
  // still holds unprocessed math. Catches races between an append and engine
  // readiness without paying for a full pass on the healthy path.
  useEffect(() => {
    if (isSourceMode || renderProgress) return;
    const root = previewRef.current;
    if (!root) return;
    const raw = Array.from(root.querySelectorAll('.render-chunk')).filter(
      (chunk) =>
        (chunk.querySelector('.math-equation-row') || chunk.querySelector('.math-inline')) &&
        !chunk.querySelector('mjx-container')
    ) as HTMLElement[];
    if (raw.length) triggerMathJax(root);   // single call keeps texReset from interleaving
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderProgress, isSourceMode]);

  // A theme change DOES require repainting every diagram (mermaid bakes colours in).
  useEffect(() => {
    if (previewRef.current && !isSourceMode) {
      renderMermaidDiagrams(previewRef.current, appTheme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appTheme, isSourceMode]);

  // Apply a position handed over from the preview (double-click, mode toggle).
  // The textarea already exists because the source view was just opened.
  useEffect(() => {
    if (!isSourceMode) return;
    const offset = pendingSourceCaretRef.current;
    if (offset === null) return;
    const ta = textareaRef.current;
    if (!ta) return;
    pendingSourceCaretRef.current = null;
    const pos = Math.max(0, Math.min(offset, ta.value.length));
    // Defer one frame so the textarea has been laid out and can scroll.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
      const style = window.getComputedStyle(ta);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      // Real measured caret geometry, so wrapped paragraphs cannot shift the
      // highlight onto a neighbouring line.
      const caret = measureTextareaCaret(ta, pos);
      // Place the target roughly one third down the viewport, independently of
      // any scroll offset the textarea already had.
      ta.scrollTop = Math.max(0, caret.top - ta.clientHeight / 3);

      // A caret alone is nearly invisible in a wall of text; flash the line it
      // landed on, plus a tick under the exact column.
      const pane = ta.parentElement;
      if (pane) {
        const paneTop = ta.offsetTop;
        flashAnchorRef.current = { paneTop, contentTop: caret.top };
        setCaretFlash({
          top: paneTop + caret.top - ta.scrollTop,
          left: ta.offsetLeft + paddingLeft,
          width: Math.max(0, ta.clientWidth - paddingLeft - paddingRight),
          height: caret.height,
          tickLeft: ta.offsetLeft + caret.caretLeft
        });
      }
    });
  }, [isSourceMode]);

  // The flash is transient: fade it out on its own, and clear it the moment the
  // writer interacts with the text, so it never lingers as visual noise.
  useEffect(() => {
    if (!caretFlash) return;
    const timer = window.setTimeout(() => setCaretFlash(null), 2500);
    return () => window.clearTimeout(timer);
  }, [caretFlash]);

  // While the landing highlight is alive it must stay glued to its line: track
  // the textarea's own scrolling and re-anchor.
  useEffect(() => {
    if (!caretFlash) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const sync = () => {
      const anchor = flashAnchorRef.current;
      if (!anchor) return;
      setCaretFlash((prev) => (prev ? { ...prev, top: anchor.paneTop + anchor.contentTop - ta.scrollTop } : prev));
    };
    ta.addEventListener('scroll', sync, { passive: true });
    return () => ta.removeEventListener('scroll', sync);
  }, [caretFlash]);

  // Returning from the source view: scroll the preview back to the block that
  // holds the caret, so editing never throws the reader to the top.
  useEffect(() => {
    if (isSourceMode) return;
    const pending = pendingPreviewScrollRef.current;
    if (!pending) return;
    // Hold the request until the preview shows this exact revision; otherwise
    // the measurement would run against stale HTML and land in the wrong place.
    if (renderedForContentRef.current !== pending.content) return;
    if (pending.tabId !== activeFileIdRef.current) return;
    const offset = pending.offset;

    const article = previewRef.current;
    const scroller = article?.closest('.typora-document-scroll') as HTMLElement | null;
    const source = activeFile?.content || '';
    if (!article || !scroller || !source) return;

    // With chunked rendering the target block may not be mounted yet: keep the
    // request pending and let this effect retry as further chunks arrive.
    const target = blockForSourceOffset(article, source, offset);
    if (!target) return;
    pendingPreviewScrollRef.current = null;

    // Absolute geometry via rects: offsetTop is unreliable because neither
    // .typora-document-scroll nor .typora-paper-article is positioned.
    const reveal = () => {
      const delta = target!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 24);
    };
    requestAnimationFrame(reveal);
    // Re-apply once the async typesetters have reflowed the article.
    const settle = window.setTimeout(reveal, 350);
    // Mark the block the caret came back to, so the return landing is as
    // findable as the jump into the source view.
    target.classList.add('jump-target-flash');
    const clearFlash = window.setTimeout(() => target.classList.remove('jump-target-flash'), 2500);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(clearFlash);
      target.classList.remove('jump-target-flash');
    };
  }, [isSourceMode, renderChunks.length]);

  // Production build fix: listen for mathjax-ready event when MathJax finishes async loading
  useEffect(() => {
    const handleMathJaxReady = () => {
      if (previewRef.current && !isSourceMode) {
        triggerMathJax(previewRef.current);
      }
    };
    window.addEventListener('mathjax-ready', handleMathJaxReady);
    if ((window as any).__MATHJAX_READY__) {
      handleMathJaxReady();
    }
    return () => window.removeEventListener('mathjax-ready', handleMathJaxReady);
  }, [isSourceMode]);

// --- Outline Extraction (TOC) ---
  const outlineList = useMemo<OutlineItem[]>(() => {
    if (!activeFile?.content) return [];
    const items: OutlineItem[] = [];
    const lines = activeFile.content.split('\n');
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        const level = m[1].length;
        const title = m[2].trim().replace(/[*_`#]/g, '');
        const slug = encodeURIComponent(title.toLowerCase().replace(/\s+/g, '-'));
        items.push({ level, title, line: i, slug });
      }
    }
    return items;
  }, [activeFile?.content]);

  // Handle clicking outline item
  const handleOutlineClick = (item: OutlineItem) => {
    if (isSourceMode) {
      const ta = textareaRef.current;
      if (!ta) return;
      const lines = (activeFile?.content || '').split('\n');
      let charIndex = 0;
      for (let i = 0; i < item.line && i < lines.length; i++) {
        charIndex += lines[i].length + 1;
      }
      const pos = Math.max(0, Math.min(charIndex, ta.value.length));
      // Land the caret at the very START of the heading line and select nothing:
      // the jump must not paint the whole title as selected, and the author must
      // be able to edit the '#' prefix right away (so the marker is NOT skipped).
      const caretAt = pos;
      ta.focus();
      ta.setSelectionRange(caretAt, caretAt);
      // A fixed line height cannot address the target: wrapped lines make the
      // real pixel offset diverge from `line * lineHeight`. Measure the caret
      // geometry instead (same machinery as the preview double-click landing).
      requestAnimationFrame(() => {
        const caret = measureTextareaCaret(ta, caretAt);
        ta.scrollTop = Math.max(0, caret.top - ta.clientHeight / 3);
        const pane = ta.parentElement;
        if (pane) {
          const style = window.getComputedStyle(ta);
          const paddingLeft = parseFloat(style.paddingLeft) || 0;
          const paddingRight = parseFloat(style.paddingRight) || 0;
          const paneTop = ta.offsetTop;
          flashAnchorRef.current = { paneTop, contentTop: caret.top };
          setCaretFlash({
            top: paneTop + caret.top - ta.scrollTop,
            left: ta.offsetLeft + paddingLeft,
            width: Math.max(0, ta.clientWidth - paddingLeft - paddingRight),
            height: caret.height,
            tickLeft: ta.offsetLeft + caret.caretLeft
          });
        }
      });
    } else {
      const el = document.getElementById(`heading-${item.slug}`) ||
                 Array.from(document.querySelectorAll(`h${item.level}`)).find(h => (h.textContent || '').includes(item.title));
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };

  // Load workspace files when activeFile changes or directory is selected
  const loadWorkspaceFiles = useCallback(async (dirPath: string) => {
    try {
      const entries = await invoke<FileEntry[]>('read_dir_files', { dirPath });
      setWorkspaceFiles(entries);
      setWorkspaceDir(dirPath);
      setExpandedDirs({ [dirPath]: true });
      dirChildrenCacheRef.current = { [dirPath]: entries };
      setDirChildrenCache({ [dirPath]: entries });
    } catch {
      setWorkspaceFiles([]);
    }
  }, []);

  const handleSelectWorkspace = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === 'string') {
        await loadWorkspaceFiles(selected);
        setIsSidebarOpen(true);
        setSidebarPanel('workspace');
      }
    } catch (e) {
      console.error('Select workspace error:', e);
    }
  };

  // Cycle open document tabs (Ctrl+Tab)
  const handleCycleTab = useCallback(() => {
    if (openFiles.length <= 1) return;
    const currentIndex = openFiles.findIndex((f) => f.id === activeFileId);
    const nextIndex = (currentIndex + 1) % openFiles.length;
    setActiveFileId(openFiles[nextIndex].id);
  }, [openFiles, activeFileId]);

  /**
   * Edit-menu commands. Clicking a dropdown item blurs the source textarea, so
   * the command must re-focus the editor first - otherwise undo/redo/copy/paste
   * act on a stale page selection (or on nothing) instead of the text being
   * edited. Falls back to the plain command in preview mode, where there is no
   * editable textarea.
   */
  const runEditorCommand = (command: 'undo' | 'redo' | 'copy' | 'paste' | 'cut') => {
    const ta = textareaRef.current;
    if (ta) ta.focus();
    try {
      document.execCommand(command);
    } catch {
      /* the webview may refuse paste without clipboard permission */
    }
    setActiveMenu(null);
  };

  /** One-tap search: open the sidebar and switch its tree region to search. */
  const openSearchPanel = () => {
    setIsSidebarOpen(true);
    setSidebarPanel('search');
    setActiveMenu(null);
  };

  /** Theme cycle: auto -> light -> dark -> sepia -> auto. */
  const cycleTheme = () =>
    setThemePref((t) => THEME_CYCLE[(THEME_CYCLE.indexOf(t) + 1) % THEME_CYCLE.length]);

  const themeIconName = (): 'monitor' | 'sun' | 'moon' | 'book' => {
    if (themePref === 'auto') return 'monitor';
    return appTheme === 'dark' ? 'moon' : (appTheme === 'sepia' ? 'book' : 'sun');
  };

  /** Outline items with the subtree of every collapsed heading filtered out. */
  // Outline rows: a node's caret must not depend on its own collapsed state, so
  // hasChild is computed from the FULL outline list. Descendants of a collapsed
  // node are skipped while walking the pre-order list.
  const outlineRows = useMemo(() => {
    const rows: (OutlineItem & { hasChild: boolean; collapsed: boolean })[] = [];
    let hideDeeperThan: number | null = null;
    for (let i = 0; i < outlineList.length; i++) {
      const it = outlineList[i];
      if (hideDeeperThan !== null && it.level > hideDeeperThan) continue;
      hideDeeperThan = null;
      const hasChild = i + 1 < outlineList.length && outlineList[i + 1].level > it.level;
      const collapsed = collapsedOutline.has(it.line);
      rows.push({ ...it, hasChild, collapsed });
      if (hasChild && collapsed) hideDeeperThan = it.level;
    }
    return rows;
  }, [outlineList, collapsedOutline]);

  const toggleOutlineNode = useCallback((line: number) => {
    setCollapsedOutline((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }, []); 
  // Window controls
  const handleToggleFullscreen = async () => {
    try {
      const nextState = await invoke<boolean>('toggle_fullscreen');
      setIsFullscreen(nextState);
    } catch {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
        setIsFullscreen(true);
      } else {
        document.exitFullscreen().catch(() => {});
        setIsFullscreen(false);
      }
    }
  };

  const handleToggleAlwaysOnTop = async () => {
    const next = !isAlwaysOnTop;
    try {
      await invoke('toggle_always_on_top', { enable: next });
      setIsAlwaysOnTop(next);
    } catch {
      setIsAlwaysOnTop(next);
    }
  };

  /** Enter the source view with the caret at the position double-clicked. */
  const handlePreviewDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const source = activeFile?.content || '';
    const target = event.target as HTMLElement;
    const offset = target
      ? sourceOffsetForElement(target, source, previewRef.current, { x: event.clientX, y: event.clientY })
      : null;
    pendingSourceCaretRef.current = offset;
    setIsSourceMode(true);
  };

  /**
   * Source offset of the first preview block at or below the fold, i.e. what
   * the reader is currently looking at. Used when the view is switched from the
   * keyboard or the menu, where there is no clicked element to resolve.
   */
  const previewTopSourceOffset = (): number | null => {
    const article = previewRef.current;
    const scroller = article?.closest('.typora-document-scroll') as HTMLElement | null;
    const source = activeFile?.content || '';
    if (!article || !scroller || !source.trim()) return null;

    const index = getSourceIndex(source);
    const foldTop = scroller.getBoundingClientRect().top + 8;
    let cursor = 0;
    for (const el of Array.from(article.children) as HTMLElement[]) {
      const anchor = firstAnchorIn(el);
      let at: number | null = anchor ? anchor.start : null;
      if (at === null) {
        const probe = probeTextOf(el);
        if (!probe.trim()) continue;
        at = locateRenderedText(index, probe, cursor);
        if (at === null) continue;
      }
      cursor = Math.max(cursor, at); // every located block advances the search
      if (el.getBoundingClientRect().bottom >= foldTop) return at;
    }
    return null;
  };

  /** Open the source view, landing at `offset` or wherever the reader is. */
  const enterSourceMode = (offset?: number | null) => {
    pendingSourceCaretRef.current = offset !== undefined ? offset : previewTopSourceOffset();
    setIsSourceMode(true);
  };

  /** Switch views, carrying the reading position across in either direction. */
  const toggleSourceMode = () => {
    if (isSourceMode) {
      const ta = textareaRef.current;
      pendingPreviewScrollRef.current = ta
        ? { tabId: activeFileId, content: activeFile?.content || '', offset: ta.selectionStart }
        : null;
      // Flush the pending debounce: the restore effect measures the preview
      // against activeFile.content, so the two must not be out of step.
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (activeFile) {
        updatePreview(activeFile.content, activeFile.path);
      }
      setIsSourceMode(false);
    } else {
      enterSourceMode();
    }
  };

  const handleOpenDevTools = async () => {
    try {
      await invoke('open_devtools');
    } catch {
      alert('已发送开发者工具唤起指令。');
    }
  };

  // Word count metrics computation
  const metrics = useMemo(() => {
    const content = activeFile?.content || '';
    const cjkMatches = content.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || [];
    const cjkCount = cjkMatches.length;
    const cleanForWords = content.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
    const wordMatches = cleanForWords.match(/\b[A-Za-z0-9_-]+\b/g) || [];
    const wordsCount = wordMatches.length;
    const charWithSpaces = content.length;
    const charNoSpaces = content.replace(/\s/g, '').length;
    const lines = content === '' ? 0 : content.split('\n').length;
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
    const readingMinutes = Math.max(1, Math.ceil((cjkCount / 350) + (wordsCount / 200)));
    return {
      cjkCount,
      wordsCount,
      charWithSpaces,
      charNoSpaces,
      lines,
      paragraphs,
      readingMinutes
    };
  }, [activeFile?.content]);

  // Search & Replace handlers
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query || !activeFile?.content) {
      setSearchMatchesCount(0);
      setCurrentMatchIndex(0);
      return;
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const matches = activeFile.content.match(regex);
    setSearchMatchesCount(matches ? matches.length : 0);
    setCurrentMatchIndex(0);
  };

  const handleNavigateMatch = (delta: number) => {
    if (searchMatchesCount <= 0) return;
    const nextIdx = (currentMatchIndex + delta + searchMatchesCount) % searchMatchesCount;
    setCurrentMatchIndex(nextIdx);
  };

  const handleReplaceOne = () => {
    if (!searchQuery || !activeFile?.content) return;
    const idx = activeFile.content.indexOf(searchQuery);
    if (idx !== -1) {
      const newContent = activeFile.content.substring(0, idx) + replaceQuery + activeFile.content.substring(idx + searchQuery.length);
      handleContentChange(newContent);
      handleSearch(searchQuery);
    }
  };

  const handleReplaceAll = () => {
    if (!searchQuery || !activeFile?.content) return;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const newContent = activeFile.content.replace(new RegExp(escaped, 'g'), replaceQuery);
    handleContentChange(newContent);
    handleSearch(searchQuery);
  };

    // Global click to close menus
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.menu-item-wrap') && !target.closest('.file-select-dropdown') && !target.closest('.wb-menu-host')) {
        setActiveMenu(null);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  // Keyboard shortcuts (Comprehensive Typora & MarkdownX Keybindings)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Function keys
      if (e.key === 'F8') {
        e.preventDefault();
        setIsFocusMode((prev) => !prev);
        return;
      } else if (e.key === 'F9') {
        e.preventDefault();
        setIsTypewriterMode((prev) => !prev);
        return;
      } else if (e.key === 'F11') {
        e.preventDefault();
        handleToggleFullscreen();
        return;
      } else if (e.shiftKey && e.key === 'F12') {
        e.preventDefault();
        handleOpenDevTools();
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'Tab') {
          e.preventDefault();
          handleCycleTab();
          return;
        }

        // Shift combinations
        if (e.shiftKey) {
          if (e.key === 'L' || e.key === 'l') {
            e.preventDefault();
            setIsSidebarOpen((prev) => !prev);
            return;
          } else if (e.key === '1' || e.key === '!') {
            e.preventDefault();
            // outline lives inside the workspace panel
            setIsSidebarOpen(true);
            setSidebarPanel('workspace');
            setOutlineRegionOpen(true);
            return;
          } else if (e.key === '2' || e.key === '@') {
            e.preventDefault();
            setIsInspectorOpen((v) => !v);
            return;
          } else if (e.key === 'F' || e.key === 'f') {
            e.preventDefault();
            setIsSidebarOpen(true);
            setSidebarPanel('search');
            return;
          } else if (e.key === '9' || e.key === '(') {
            e.preventDefault();
            setZoomLevel(1.0);
            return;
          } else if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            setZoomLevel((z) => Math.min(2.0, Number((z + 0.1).toFixed(1))));
            return;
          } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            setZoomLevel((z) => Math.max(0.6, Number((z - 0.1).toFixed(1))));
            return;
          } else if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            handleSaveFileAs();
            return;
          }
        }

        // Standard Ctrl combinations
        if (e.key === '/') {
          e.preventDefault();
          toggleSourceMode();
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          handleSaveFile();
        } else if (e.key === 'o' || e.key === 'O') {
          e.preventDefault();
          handleOpenFile();
        } else if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          handleNewFile();
        } else if (e.key === 'p' || e.key === 'P') {
          e.preventDefault();
          handlePrint();
        } else if (e.key === ',' || e.key === '，') {
          e.preventDefault();
          setSettingsModalView('preferences');
          setShowTypographyModal(true);
        } else if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          handleCloseFile(activeFileId);
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          setTypography((t) => ({ ...t, fontSize: Math.min(t.fontSize + 1, 26) }));
        } else if (e.key === '-') {
          e.preventDefault();
          setTypography((t) => ({ ...t, fontSize: Math.max(t.fontSize - 1, 12) }));
        } else if (e.key === '0') {
          e.preventDefault();
          setTypography((t) => ({ ...t, fontSize: 16 }));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleNewFile = () => {
    setActiveMenu(null);
    const newId = `file-${Date.now()}`;
    const newTab: FileTab = {
      id: newId,
      name: `未命名文档-${openFiles.length + 1}.md`,
      path: null,
      content: '# 新建文档\n\n在此开始输入内容...',
      isModified: false
    };
    setOpenFiles((prev) => [...prev, newTab]);
    setActiveFileId(newId);
  };

  // Helper to open a file by path (supports CLI launch, file association double-click, and dialog)
  const openFileByPath = useCallback(async (targetPath: string) => {
    try {
      // Read through the ref mirror instead of mutating state inside an updater
      const existing = openFilesRef.current.find((f) => f.path === targetPath);
      if (existing) {
        setActiveFileId(existing.id);
        return;
      }

      let fileContent = '';
      try {
        fileContent = await invoke<string>('read_file_from_path', { path: targetPath });
      } catch {
        fileContent = await readTextFile(targetPath);
      }

      const fileName = targetPath.split(/[\/]/).pop() || 'document.md';
      const newId = `file-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const newTab: FileTab = {
        id: newId,
        name: fileName,
        path: targetPath,
        content: fileContent,
        isModified: false
      };

      // Compose the next tab list outside of any updater, then write state.
      const currentTabs = openFilesRef.current;
      const nextTabs =
        currentTabs.length === 1 && currentTabs[0].id === 'default-tab' && !currentTabs[0].path && currentTabs[0].content === ''
          ? [newTab]
          : [...currentTabs, newTab];
      openFilesRef.current = nextTabs; // keep the mirror fresh for sequential opens
      setOpenFiles(nextTabs);
      setActiveFileId(newTab.id);

      setRecentFiles((prev) => [
        { name: fileName, path: targetPath },
        ...prev.filter((item) => item.path !== targetPath)
      ].slice(0, 10));
    } catch (error) {
      console.error('File open error:', error);
    }
  }, []);

  // Listen for CLI arguments on initial startup (double-clicking an associated .md file)
  useEffect(() => {
    const checkInitialCliArgs = async () => {
      try {
        const args = await invoke<string[]>('get_cli_args');
        if (args && args.length > 0) {
          for (const arg of args) {
            if (!arg.startsWith('-')) {
              await openFileByPath(arg);
              break;
            }
          }
        }
      } catch (err) {
        console.warn('Could not read CLI args:', err);
      }
    };

    checkInitialCliArgs();
  }, [openFileByPath]);

  // Listen for file open requests forwarded from subsequent instances (single-instance plugin)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setupListener = async () => {
      try {
        unlisten = await listen<string[]>('open-file-from-cli', async (event) => {
          const args = event.payload;
          if (args && args.length > 0) {
            for (const arg of args) {
              if (!arg.startsWith('-')) {
                await openFileByPath(arg);
                break;
              }
            }
          }
        });
      } catch (err) {
        console.warn('Could not setup single-instance listener:', err);
      }
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, [openFileByPath]);

  const handleOpenFile = async (specificPath?: string) => {
    setActiveMenu(null);
    try {
      let targetPath = specificPath;
      if (!targetPath) {
        const selected = await open({
          filters: [{ name: 'Markdown Documents', extensions: ['md', 'markdown', 'txt'] }],
          multiple: false
        });
        if (typeof selected === 'string') {
          targetPath = selected;
        }
      }

      if (targetPath) {
        await openFileByPath(targetPath);
      }
    } catch (error) {
      console.error('File open error:', error);
    }
  };

  const handleSaveFile = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      let targetPath = activeFile.path;
      if (!targetPath) {
        targetPath = await save({
          filters: [{ name: 'Markdown Documents', extensions: ['md'] }]
        });
      }

      if (targetPath) {
        lastSelfSaveTimeRef.current = Date.now();
        await writeTextFile(targetPath, activeFile.content);
        clearFileConflict(activeFileId);
        const fileName = targetPath.split(/[\/\\]/).pop() || 'document.md';
        setOpenFiles((prev) =>
          prev.map((f) => (f.id === activeFileId ? { ...f, path: targetPath, name: fileName, isModified: false } : f))
        );
      }
    } catch (error) {
      console.error('File save error:', error);
    }
  };

  const handleSaveFileAs = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const targetPath = await save({
        filters: [{ name: 'Markdown Documents', extensions: ['md'] }]
      });

      if (targetPath) {
        lastSelfSaveTimeRef.current = Date.now();
        await writeTextFile(targetPath, activeFile.content);
        clearFileConflict(activeFileId);
        invoke('start_watching_file', { filePath: targetPath }).catch(() => {});
        const fileName = targetPath.split(/[\/\\]/).pop() || 'document.md';
        setOpenFiles((prev) =>
          prev.map((f) => (f.id === activeFileId ? { ...f, path: targetPath, name: fileName, isModified: false } : f))
        );
      }
    } catch (error) {
      console.error('File save-as error:', error);
    }
  };


  // ==========================================
  // Export Handlers (PDF, HTML, Word, LaTeX)
  // ==========================================


  // Save current settings as permanent program defaults
  const handleSaveAsProgramDefaults = () => {
    const newDefaults: AppPreferences = {
      defaultTheme: defaultThemeSetting,
      defaultViewMode: defaultModeSetting,
      defaultMathEngine: defaultMathEngineSetting,
      autoWatchExternalChanges: autoWatchSetting,
      defaultTypography: { ...typography }
    };
    try {
      localStorage.setItem('markdownx_app_preferences_v140', JSON.stringify(newDefaults));
      localStorage.setItem('markdownx_math_engine', defaultMathEngineSetting);
      setModalFeedback('✓ 已成功将当前设置保存为程序全局默认值！');
      setTimeout(() => setModalFeedback(null), 3000);
    } catch {
      setModalFeedback('保存默认值失败，请检查浏览器存储权限。');
    }
  };

  // Reset to factory defaults
  const handleResetFactoryDefaults = () => {
    try {
      localStorage.removeItem('markdownx_app_preferences_v140');
      localStorage.removeItem('markdownx_math_engine');
      setTypography(FACTORY_PREFERENCES.defaultTypography);
      setThemePref(FACTORY_PREFERENCES.defaultTheme);
      setDefaultThemeSetting(FACTORY_PREFERENCES.defaultTheme);
      setDefaultModeSetting(FACTORY_PREFERENCES.defaultViewMode);
      setDefaultMathEngineSetting(FACTORY_PREFERENCES.defaultMathEngine || 'svg');
      setAutoWatchSetting(true);
      setModalFeedback('✓ 已恢复程序出厂默认配置！');
      setTimeout(() => setModalFeedback(null), 3000);
    } catch {}
  };

  // 1. Independent Print handler (Ctrl + P) - Keeps system print dialog 100% active
  const handlePrint = () => {
    setActiveMenu(null);
    if (isSourceMode) {
      // Route through toggleSourceMode so the reading position is carried back
      // into the preview instead of dumping the reader at the top.
      toggleSourceMode();
      setTimeout(() => window.print(), 350);
    } else {
      window.print();
    }
  };

  // 2. Export HTML with embedded styles & MathJax
  const handleExportHtmlWithStyles = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '.html';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'HTML Document', extensions: ['html', 'htm'] }]
      });

      if (targetPath) {
        const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${activeFile.name.replace(/\.[^/.]+$/, '')}</title>
  <script>
    window.MathJax = {
      tex: {
        inlineMath: [['$', '$']],
        displayMath: [['$$', '$$']],
        processEscapes: true
      },
      svg: {
        fontCache: 'global'
      },
      options: {
        enableMenu: false,
        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      }
    };
  </script>
  <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-svg.js"></script>
  <style>
    body {
      font-family: ${typography.latinFont}, ${typography.cjkFont}, serif;
      font-size: ${typography.fontSize}px;
      line-height: ${typography.lineHeight};
      color: ${appTheme === 'dark' ? '#f1f5f9' : (appTheme === 'sepia' ? '#3d352a' : '#1f2937')};
      background-color: ${appTheme === 'dark' ? '#0f172a' : (appTheme === 'sepia' ? '#fbf6ec' : '#ffffff')};
      margin: 0;
      padding: 48px 24px;
    }
    .markdownx-exported-doc {
      max-width: ${typography.maxWidth};
      margin: 0 auto;
    }
    p {
      margin-bottom: ${typography.paragraphMargin}em;
      text-align: ${typography.textAlign};
      text-align-last: left;
      text-indent: ${typography.firstLineIndent ? '2em' : '0'};
      word-break: break-word;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1.8em 0;
      border-top: 2.2px solid #1f2937;
      border-bottom: 2.2px solid #1f2937;
    }
    th {
      border-bottom: 1.2px solid #374151;
      padding: 10px 14px;
      text-align: left;
      background: #f8fafc;
    }
    td {
      border-bottom: 1px solid #e5e7eb;
      padding: 9px 14px;
      text-align: left;
    }
    .math-equation-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin: 1.5em 0;
    }
    .math-equation-content {
      flex: 1;
      text-align: center;
      overflow-x: auto;
    }
    mjx-container {
      color: ${appTheme === 'dark' ? '#f8fafc' : (appTheme === 'sepia' ? '#3d352a' : '#1f2937')} !important;
    }
    .math-equation-tag {
      font-size: 15px;
      color: ${appTheme === 'dark' ? '#94a3b8' : '#6b7280'};
      padding-left: 20px;
      flex-shrink: 0;
    }
    .equation-ref-link {
      color: #0969da;
      text-decoration: none;
      border-bottom: 1px dashed #0969da;
    }
    pre {
      background: #f6f8fa;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 14px 18px;
      overflow-x: auto;
    }
    .code-block-header {
      display: none;
    }
    .callout-card {
      margin: 1.5em 0;
      border-radius: 6px;
      border-left: 4px solid #0969da;
      background-color: rgba(9, 105, 218, 0.05);
      padding: 12px 18px;
    }
    .callout-header {
      font-weight: 600;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="markdownx-exported-doc">
    ${await awaitRenderedHtml()}
  </div>
</body>
</html>`;
        await writeTextFile(targetPath, fullHtml);
      }
    } catch (err) {
      console.error('HTML export error:', err);
    }
  };

  // 3. Export plain HTML without styles
  const handleExportHtmlPlain = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '_plain.html';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'HTML Document', extensions: ['html', 'htm'] }]
      });

      if (targetPath) {
        const plainHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${activeFile.name.replace(/\.[^/.]+$/, '')}</title>
</head>
<body>
${await awaitRenderedHtml()}
</body>
</html>`;
        await writeTextFile(targetPath, plainHtml);
      }
    } catch (err) {
      console.error('Plain HTML export error:', err);
    }
  };

  // 4. Export LaTeX (.tex) manuscript
  const handleExportLatex = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '.tex';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'LaTeX Document', extensions: ['tex'] }]
      });

      if (targetPath) {
        let texBody = activeFile.content;
        texBody = texBody.replace(/^# (.+)$/gm, '\\section{$1}');
        texBody = texBody.replace(/^## (.+)$/gm, '\\subsection{$1}');
        texBody = texBody.replace(/^### (.+)$/gm, '\\subsubsection{$1}');
        texBody = texBody.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
        texBody = texBody.replace(/\*(.+?)\*/g, '\\textit{$1}');
        texBody = texBody.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '\\begin{verbatim}\n$1\\end{verbatim}');

        const texDoc = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{geometry}
\\geometry{a4paper, margin=1in}

\\title{${activeFile.name.replace(/\.[^/.]+$/, '')}}
\\author{MarkdownX}
\\date{\\today}

\\begin{document}
\\maketitle

${texBody}

\\end{document}
`;
        await writeTextFile(targetPath, texDoc);
      }
    } catch (err) {
      console.error('LaTeX export error:', err);
    }
  };

  // 5. Export Word (.docx / .doc) with native MSO XML packaging
  const handleExportWord = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '.doc';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'Word Document', extensions: ['doc', 'docx'] }]
      });

      if (targetPath) {
        const wordDocument = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
  <meta charset='utf-8'>
  <title>${activeFile.name.replace(/\.[^/.]+$/, '')}</title>
  <!--[if gte mso 9]>
  <xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml>
  <![endif]-->
  <style>
    body {
      font-family: 'Times New Roman', SimSun, serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #000000;
    }
    h1 { font-size: 18pt; font-weight: bold; border-bottom: 1px solid #000; padding-bottom: 4pt; }
    h2 { font-size: 14pt; font-weight: bold; }
    h3 { font-size: 12pt; font-weight: bold; }
    p { margin-bottom: 8pt; text-align: justify; }
    table { border-collapse: collapse; width: 100%; margin: 12pt 0; border-top: 2pt solid #000; border-bottom: 2pt solid #000; }
    th { border-bottom: 1pt solid #000; padding: 6pt; font-weight: bold; text-align: left; }
    td { border-bottom: 0.5pt solid #ddd; padding: 5pt; text-align: left; }
    pre { background: #f4f4f4; border: 1px solid #ddd; padding: 8pt; font-family: Consolas, monospace; font-size: 9.5pt; }
  </style>
</head>
<body>
  <div>
    ${await awaitRenderedHtml()}
  </div>
</body>
</html>`;
        await writeTextFile(targetPath, wordDocument);
      }
    } catch (err) {
      console.error('Word export error:', err);
    }
  };


  const handleCloseFile = (idToClose: string) => {
    setActiveMenu(null);
    const tabToClose = openFiles.find((f) => f.id === idToClose);
    if (tabToClose?.path) {
      invoke('stop_watching_file', { filePath: tabToClose.path }).catch(() => {});
    }
    clearFileConflict(idToClose);
    if (openFiles.length <= 1) {
      setOpenFiles([{
        id: 'default-tab',
        name: '未命名文档.md',
        path: null,
        content: '',
        isModified: false
      }]);
      setActiveFileId('default-tab');
      return;
    }

    const remaining = openFiles.filter((f) => f.id !== idToClose);
    setOpenFiles(remaining);
    if (activeFileId === idToClose) {
      setActiveFileId(remaining[remaining.length - 1].id);
    }
  };


  // Tauri native drag-and-drop listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setupTauriDnD = async () => {
      try {
        const appWin = getCurrentWindow();
        unlisten = await appWin.onDragDropEvent((event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            setIsDragging(true);
          } else if (event.payload.type === 'drop') {
            setIsDragging(false);
            const droppedPaths = event.payload.paths;
            if (droppedPaths && droppedPaths.length > 0) {
              handleOpenFile(droppedPaths[0]);
            }
          } else if (event.payload.type === 'leave') {
            setIsDragging(false);
          }
        });
      } catch {
        // Safe fallback to HTML5 drag-and-drop
      }
    };

    setupTauriDnD();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Keep the maximize/restore glyph in step with the window, and expose the three
  // caption actions. Every call is guarded: outside Tauri (browser harness) the
  // window API is absent and the controls simply do nothing.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      const appWin = getCurrentWindow();
      const sync = () => {
        appWin.isMaximized()
          .then((maximized) => { if (!disposed) setIsWindowMaximized(!!maximized); })
          .catch(() => {});
      };
      sync();
      appWin.onResized(sync)
        .then((un) => { if (disposed) un(); else unlisten = un; })
        .catch(() => {});
    } catch {
      // No Tauri window (plain browser): leave the controls inert.
    }
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);

  // A rejected call here is almost always a missing capability (Tauri v2 gates
  // every window mutation behind an ACL entry), and swallowing it silently is
  // exactly how a dead button ships. Log it, and keep the UI alive.
  const runWindowCommand = (label: string, run: () => Promise<void>) => {
    const report = (err: unknown) => {
      console.warn(`[MarkdownX] window command "${label}" was refused:`, err);
      setWindowCmdNotice(`窗口命令「${label}」被拒绝：${String(err)}`);
    };
    try {
      run().catch(report);
    } catch (err) {
      report(err);
    }
  };
  const handleWindowMinimize = () => runWindowCommand('minimize', () => getCurrentWindow().minimize());
  const handleWindowToggleMaximize = () => runWindowCommand('toggle-maximize', () => getCurrentWindow().toggleMaximize());
  const handleWindowClose = () => runWindowCommand('close', () => getCurrentWindow().close());

  // Rust Native File Watcher (Notify Crate) integration
  useEffect(() => {
    if (!autoWatchSetting) return;

    // Start watching all open file paths with Rust backend
    openFiles.forEach((file) => {
      if (file.path) {
        invoke('start_watching_file', { filePath: file.path }).catch(() => {});
      }
    });
  }, [openFiles, autoWatchSetting]);

  useEffect(() => {
    if (!autoWatchSetting) return;

    let unlisten: (() => void) | undefined;
    const setupFileWatcherListener = async () => {
      try {
        unlisten = await listen<string>('file-modified-on-disk', async (event) => {
          const modifiedPath = event.payload;
          if (!modifiedPath) return;

          // 1. Guard against self-saves within 1.5s
          if (Date.now() - lastSelfSaveTimeRef.current < 1500) {
            return;
          }

          // 2. Debounce rapid OS writes within 400ms
          if (Date.now() - lastHandledTimeRef.current < 400) {
            return;
          }
          lastHandledTimeRef.current = Date.now();

          const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
          const targetNorm = norm(modifiedPath);

          const match = openFilesRef.current.find(
            (f) => f.path && (norm(f.path) === targetNorm || targetNorm.endsWith(norm(f.path)))
          );
          if (!match || !match.path) return;

          const targetId = match.id;
          const targetName = match.name;
          const targetPath = match.path;

          // 3. Disk read happens OUTSIDE any state updater (pure updaters only)
          let diskContent: string;
          try {
            diskContent = await readTextFile(targetPath);
          } catch (err) {
            console.warn('[FileWatcher] Read disk file error:', err);
            return;
          }

          // Re-read the freshest tab state after the async disk read
          const latest = openFilesRef.current.find((f) => f.id === targetId);
          if (!latest || latest.path !== targetPath) return; // tab closed or re-pointed meanwhile
          if (diskContent === latest.content) return;

          if (!latest.isModified) {
            // Case 1: Unmodified in MarkdownX -> Silent Auto-reload
            setOpenFiles((current) =>
              current.map((t) =>
                t.id === targetId ? { ...t, content: diskContent, isModified: false } : t
              )
            );
            if (targetId === activeFileIdRef.current) {
              setExternalReloadNotice(`✓ 外部更新：已自动同步「${targetName}」最新内容`);
              setTimeout(() => setExternalReloadNotice(null), 3000);
            }
          } else {
            // Case 2: Modified locally -> persist the conflict for THIS tab
            // (background tabs are no longer silently dropped; disk content is cached)
            setFileConflicts((prev) => ({
              ...prev,
              [targetId]: { tabId: targetId, fileName: targetName, filePath: targetPath, diskContent }
            }));
            if (targetId !== activeFileIdRef.current) {
              setExternalReloadNotice(`⚠️ 「${targetName}」检测到外部修改冲突，切换到该文档即可处理`);
              setTimeout(() => setExternalReloadNotice(null), 4000);
            }
          }
        });
      } catch (err) {
        console.warn('[FileWatcher] Setup listener failed:', err);
      }
    };

    setupFileWatcherListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, [autoWatchSetting]);

  // HTML5 Drag and Drop handlers
  const handleHtml5DragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleHtml5DragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleHtml5Drop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const filePath = (file as any).path;
      if (filePath) {
        handleOpenFile(filePath);
      } else {
        const text = await file.text();
        const newId = `file-${Date.now()}`;
        const newTab: FileTab = {
          id: newId,
          name: file.name,
          path: null,
          content: text,
          isModified: false
        };
        setOpenFiles((prev) => [...prev, newTab]);
        setActiveFileId(newId);
      }
    }
  };


  return (
    <div className="typora-shell" onDragOver={handleHtml5DragOver} onDragLeave={handleHtml5DragLeave} onDrop={handleHtml5Drop}>
      {/* 1. Workbench top bar: identity + document, view tabs, edit cluster, menus */}
      <header className="wb-topbar" data-tauri-drag-region>
        <div className="wb-tb-left" data-tauri-drag-region>
          <button
            className="wb-icon-btn"
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            title={`显示 / 隐藏侧边栏 (Ctrl+Shift+L)`}
          >
            <AppIcon name="sidebar-left" size={16} />
          </button>
          <MarkdownXLogo size={18} />
          {windowCmdNotice && (
            <span className="wb-cmd-notice" title={windowCmdNotice}>
              {windowCmdNotice}
            </span>
          )}
          <span className="wb-doc-name" data-tauri-drag-region title={activeFile?.path || '未保存'}>
            {activeFile?.name || 'MarkdownX'}
            {activeFile?.isModified ? <span className="wb-dirty-dot">•</span> : null}
          </span>
          <div className="wb-menu-host">
            <button
              className={`wb-icon-btn ${activeMenu === 'mainmenu' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === 'mainmenu' ? null : 'mainmenu'); }}
              title="菜单（文件 / 视图 / 主题 / 帮助）"
            >
              <AppIcon name="list-tree" size={16} />
            </button>
            {activeMenu === 'mainmenu' && (
              <div className="typora-dropdown-menu wb-dropdown">
                <div className="dropdown-item" onClick={handleNewFile}>
                  <span>新建文档</span><span className="shortcut">Ctrl+N</span>
                </div>
                <div className="dropdown-item" onClick={() => handleOpenFile()}>
                  <span>打开文件...</span><span className="shortcut">Ctrl+O</span>
                </div>
                <div className="dropdown-item" onClick={handleSelectWorkspace}>
                  <span>打开文件夹...</span>
                </div>
                <div className="dropdown-item has-submenu">
                  <span>打开最近文件</span><span className="arrow">›</span>
                  <div className="typora-submenu recent-files-submenu">
                    {recentFiles.length === 0 ? (
                      <div className="dropdown-item disabled">无最近文件</div>
                    ) : (
                      recentFiles.map((rf, idx) => (
                        <div key={idx} className="dropdown-item" onClick={() => handleOpenFile(rf.path)}>
                          <span className="file-name">{rf.name}</span>
                          <span className="file-subpath">{rf.path}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={handleSaveFile}>
                  <span>保存</span><span className="shortcut">Ctrl+S</span>
                </div>
                <div className="dropdown-item" onClick={handleSaveFileAs}>
                  <span>另存为...</span><span className="shortcut">Ctrl+Shift+S</span>
                </div>
                <div className="dropdown-item has-submenu">
                  <span>导出</span><span className="arrow">›</span>
                  <div className="typora-submenu export-submenu">
                    <div className="dropdown-item" onClick={handlePrint}>
                      <span>PDF / 打印...</span><span className="shortcut">Ctrl+P</span>
                    </div>
                    <div className="dropdown-item" onClick={handleExportHtmlWithStyles}>
                      <span>HTML (带完整样式)...</span>
                    </div>
                    <div className="dropdown-item" onClick={handleExportHtmlPlain}>
                      <span>HTML (纯净片段)...</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div className="dropdown-item" onClick={handleExportWord}>
                      <span>Word (.docx)...</span>
                    </div>
                    <div className="dropdown-item" onClick={handleExportLatex}>
                      <span>LaTeX (.tex)...</span>
                    </div>
                  </div>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { setSettingsModalView('preferences'); setShowTypographyModal(true); setActiveMenu(null); }}>
                  <span>偏好设置...</span><span className="shortcut">Ctrl+,</span>
                </div>
                <div className="dropdown-item has-submenu">
                  <span>视图</span><span className="arrow">›</span>
                  <div className="typora-submenu">
                    <div className="dropdown-item" onClick={() => { setShowStatusBar((v) => !v); setActiveMenu(null); }}>
                      <span>{showStatusBar ? '✓ 显示状态栏' : '显示状态栏'}</span>
                    </div>
                    <div className="dropdown-item" onClick={() => { setIsTypewriterMode((v) => !v); setActiveMenu(null); }}>
                      <span>{isTypewriterMode ? '✓ 打字机模式' : '打字机模式'}</span><span className="shortcut">F9</span>
                    </div>
                    <div className="dropdown-item" onClick={() => { handleToggleAlwaysOnTop(); setActiveMenu(null); }}>
                      <span>{isAlwaysOnTop ? '✓ 窗口置顶' : '窗口置顶'}</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div className="dropdown-item" onClick={() => { setZoomLevel((z) => Math.min(2.0, Number((z + 0.1).toFixed(1)))); setActiveMenu(null); }}>
                      <span>放大界面</span><span className="shortcut">Ctrl+Shift+=</span>
                    </div>
                    <div className="dropdown-item" onClick={() => { setZoomLevel((z) => Math.max(0.6, Number((z - 0.1).toFixed(1)))); setActiveMenu(null); }}>
                      <span>缩小界面</span><span className="shortcut">Ctrl+Shift+-</span>
                    </div>
                    <div className="dropdown-item" onClick={() => { setZoomLevel(1.0); setActiveMenu(null); }}>
                      <span>实际大小 {Math.round(zoomLevel * 100)}%</span><span className="shortcut">Ctrl+Shift+9</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div className="dropdown-item" onClick={() => { handleToggleFullscreen(); setActiveMenu(null); }}>
                      <span>{isFullscreen ? '退出全屏' : '进入全屏'}</span><span className="shortcut">F11</span>
                    </div>
                    <div className="dropdown-item" onClick={() => { handleOpenDevTools(); setActiveMenu(null); }}>
                      <span>开发者工具</span><span className="shortcut">Shift+F12</span>
                    </div>
                  </div>
                </div>
                <div className="dropdown-item has-submenu">
                  <span>主题</span><span className="arrow">›</span>
                  <div className="typora-submenu">
                    {THEME_OPTIONS.map((thm) => (
                      <div key={thm.id} className="dropdown-item" onClick={() => { setThemePref(thm.id); setActiveMenu(null); }}>
                        <span>{themePref === thm.id ? `✓ ${thm.icon} ${thm.name}` : `  ${thm.icon} ${thm.name}`}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="dropdown-item has-submenu">
                  <span>帮助</span><span className="arrow">›</span>
                  <div className="typora-submenu">
                    <div className="dropdown-item" onClick={() => { setShowHelpModal(true); setActiveMenu(null); }}>
                      <span>快捷键速查表</span>
                    </div>
                    <div className="dropdown-item" onClick={() => { setShowMathHelpModal(true); setActiveMenu(null); }}>
                      <span>LaTeX 公式与排版指南</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div className="dropdown-item" onClick={() => { setShowAboutModal(true); setActiveMenu(null); }}>
                      <span>关于 MarkdownX</span>
                    </div>
                  </div>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { handleCloseFile(activeFileId); setActiveMenu(null); }}>
                  <span>关闭当前文档</span><span className="shortcut">Ctrl+W</span>
                </div>
                <div className="dropdown-divider" />
                {/* Window commands live here too: the caption buttons are drawn on the
                    top bar, and this keeps them reachable when the bar is narrow. */}
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleWindowMinimize(); }}>
                  <span>最小化窗口</span>
                </div>
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleWindowToggleMaximize(); }}>
                  <span>{isWindowMaximized ? '向下还原窗口' : '最大化窗口'}</span>
                </div>
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleWindowClose(); }}>
                  <span>关闭窗口</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="wb-tb-center" data-tauri-drag-region>
          <div className="wb-view-tabs">
            <button className={`wb-view-tab ${!isSourceMode ? 'active' : ''}`} onClick={() => { if (isSourceMode) toggleSourceMode(); }} title="沉浸排版视图 (Ctrl+/)">
              排版
            </button>
            <button className={`wb-view-tab ${isSourceMode ? 'active' : ''}`} onClick={() => { if (!isSourceMode) toggleSourceMode(); }} title="源码模式 (Ctrl+/)">
              源码
            </button>
          </div>
        </div>

        <div className="wb-tb-right">
          {/* Edit cluster - kept visible by user decision, as icon buttons */}
          <div className="wb-edit-cluster">
            <button className="wb-icon-btn" onClick={() => runEditorCommand('undo')} title="撤销 (Ctrl+Z)"><AppIcon name="undo" size={15} /></button>
            <button className="wb-icon-btn" onClick={() => runEditorCommand('redo')} title="重做 (Ctrl+Y)"><AppIcon name="redo" size={15} /></button>
            <span className="wb-cluster-sep" />
            <button className="wb-icon-btn" onClick={() => runEditorCommand('cut')} title="剪切 (Ctrl+X)"><AppIcon name="scissors" size={15} /></button>
            <button className="wb-icon-btn" onClick={() => runEditorCommand('copy')} title="复制 (Ctrl+C)"><AppIcon name="copy" size={15} /></button>
            <button className="wb-icon-btn" onClick={() => runEditorCommand('paste')} title="粘贴 (Ctrl+V)"><AppIcon name="clipboard" size={15} /></button>
          </div>
          <span className="wb-cluster-sep" />
          <button
            className={`wb-icon-btn ${isFocusMode ? 'active' : ''}`}
            onClick={() => setIsFocusMode((v) => !v)}
            data-optional="true"
            title={`专注模式 (F8)`}
          >
            <AppIcon name="target" size={15} />
          </button>
          <button
            className={`wb-icon-btn ${isInspectorOpen ? 'active' : ''}`}
            onClick={() => setIsInspectorOpen((v) => !v)}
            data-optional="true"
            title="排版检查器 (Ctrl+Shift+2)"
          >
            <AppIcon name="type" size={15} />
          </button>
          <button className="wb-icon-btn" data-optional="true" onClick={cycleTheme} title={`主题：${themePref === 'auto' ? '跟随系统' : appTheme}（点击循环）`}>
            <AppIcon name={themeIconName()} size={15} />
          </button>
          {/* About: version, release notes, licence, build date. The keyboard
              cheat sheet lives in the ⋯ menu (帮助 → 快捷键速查表). */}
          <button
            className="wb-icon-btn"
            onClick={() => { setShowAboutModal(true); }}
            data-optional="true"
            title="关于 MarkdownX"
          >
            <AppIcon name="help" size={15} />
          </button>

          {/* Caption buttons: the window has no OS title bar, so these three live
              on the application's own top bar row. */}
          <div className="wb-win-controls">
            <button className="wb-win-btn" onClick={handleWindowMinimize} title="最小化" aria-label="最小化">
              <AppIcon name="win-min" size={14} strokeWidth={1.4} />
            </button>
            <button
              className="wb-win-btn"
              onClick={handleWindowToggleMaximize}
              title={isWindowMaximized ? '向下还原' : '最大化'}
              aria-label={isWindowMaximized ? '向下还原' : '最大化'}
            >
              <AppIcon name={isWindowMaximized ? 'win-restore' : 'win-max'} size={14} strokeWidth={1.4} />
            </button>
            <button className="wb-win-btn close" onClick={handleWindowClose} title="关闭" aria-label="关闭">
              <AppIcon name="close" size={14} strokeWidth={1.4} />
            </button>
          </div>
        </div>
      </header>

      {/* External File Modification Conflict Alert Banner (per-tab; shown when that tab is active) */}
      {conflictBanner && (
        <div className="file-conflict-banner">
          <div className="conflict-banner-icon">⚠️</div>
          <div className="conflict-banner-msg">
            <strong>外部修改冲突</strong>：磁盘文件「<strong>{conflictBanner.fileName}</strong>」已被外部程序更新，但您在 MarkdownX 中有未保存的修改。
          </div>
          <div className="conflict-banner-actions">
            <button
              className="conflict-btn conflict-btn-reload"
              onClick={() => {
                setOpenFiles((prev) =>
                  prev.map((t) =>
                    t.id === conflictBanner.tabId
                      ? { ...t, content: conflictBanner.diskContent, isModified: false }
                      : t
                  )
                );
                clearFileConflict(conflictBanner.tabId);
                setExternalReloadNotice(`✓ 已成功载入「${conflictBanner.fileName}」磁盘最新版本`);
                setTimeout(() => setExternalReloadNotice(null), 3000);
              }}
              title="放弃当前编辑器中的本地修改，直接载入磁盘上的最新版本"
            >
              🔄 载入磁盘最新版
            </button>
            <button
              className="conflict-btn conflict-btn-overwrite"
              onClick={() => {
                handleSaveFile();
                clearFileConflict(conflictBanner.tabId);
              }}
              title="以当前编辑器中的内容强行覆盖保存到磁盘"
            >
              💾 覆盖为当前版本
            </button>
            <button
              className="conflict-btn conflict-btn-dismiss"
              onClick={() => clearFileConflict(conflictBanner.tabId)}
              title="保留当前编辑，暂不处理"
            >
              ✕ 忽略
            </button>
          </div>
        </div>
      )}

      {/* Toast Notice for Silent External Reload */}
      {externalReloadNotice && (
        <div className="external-reload-toast">
          {externalReloadNotice}
        </div>
      )}

      {/* 3. Main Workspace & Collapsible Sidebar Container */}
      <div className="typora-main-layout">
        {/* Collapsible Sidebar */}
        {isSidebarOpen && (
          <aside className="typora-sidebar">
            <div className="sb-brand">
              <MarkdownXLogo size={22} />
              <span className="sb-brand-name">MarkdownX</span>
              <span className="sb-badge">v1.9</span>
            </div>

            <button className="sb-newdoc" onClick={handleNewFile}>
              <AppIcon name="plus-circle" size={15} />
              <span>新建文档</span>
            </button>

            <div className="sb-searchbar" onClick={openSearchPanel}>
              <AppIcon name="search" size={14} />
              <span>{sidebarPanel === 'search' ? '文档查找与替换...' : '搜索 / 替换  (Ctrl+Shift+F)'}</span>
            </div>

            <div className="sb-scroll">
              {sidebarPanel === 'search' ? (
                <div className="search-view">
                  <div className="sidebar-pane-title">文档全文查找与替换</div>
                  <div className="search-box">
                    <input
                      type="text"
                      className="search-input"
                      placeholder="查找内容..."
                      autoFocus
                      value={searchQuery}
                      onChange={(e) => handleSearch(e.target.value)}
                    />
                    <div className="search-nav-row">
                      <span className="search-count-label">
                        {searchMatchesCount > 0 ? `${currentMatchIndex + 1} / ${searchMatchesCount} 处匹配` : (searchQuery ? '无匹配项' : '输入关键词')}
                      </span>
                      <div className="search-nav-btns">
                        <button className="search-nav-btn" onClick={() => handleNavigateMatch(-1)} title="上一个匹配">▲</button>
                        <button className="search-nav-btn" onClick={() => handleNavigateMatch(1)} title="下一个匹配">▼</button>
                      </div>
                    </div>
                  </div>

                  <div className="replace-box">
                    <input
                      type="text"
                      className="replace-input"
                      placeholder="替换为..."
                      value={replaceQuery}
                      onChange={(e) => setReplaceQuery(e.target.value)}
                    />
                    <div className="replace-btns">
                      <button className="replace-action-btn" onClick={handleReplaceOne}>替换当前</button>
                      <button className="replace-action-btn" onClick={handleReplaceAll}>全部替换</button>
                    </div>
                  </div>

                  <button className="sb-back-link" onClick={() => setSidebarPanel('workspace')}>
                    ← 返回工作区
                  </button>
                </div>
              ) : (
                <>
                  {/* 大纲（树状，可逐节点折叠） */}
                  <div className="sb-region">
                    <div
                      className="sb-region-head"
                      onClick={() => setOutlineRegionOpen((v) => !v)}
                      title="点击折叠 / 展开此区域"
                    >
                      <span className={`sb-region-arrow ${outlineRegionOpen ? 'open' : ''}`}>▸</span>
                      <span className="sb-region-title">大纲 · OUTLINE</span>
                    </div>
                    {outlineRegionOpen && (
                      <div className="sb-region-body">
                        {outlineList.length === 0 ? (
                          <div className="sidebar-empty-hint">当前文档暂无标题</div>
                        ) : (
                          outlineRows.map((item, idx) => (
                            <div
                              key={`${item.line}-${idx}`}
                              className={`outline-item level-${item.level}${item.hasChild && item.collapsed ? ' has-collapsed' : ''}`}
                              style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                              title={`跳转到: ${item.title}`}
                            >
                              {item.hasChild ? (
                                <span
                                  className="outline-caret"
                                  onClick={(e) => { e.stopPropagation(); toggleOutlineNode(item.line); }}
                                  title={item.collapsed ? '展开子标题' : '折叠子标题'}
                                >
                                  {item.collapsed ? '▸' : '▾'}
                                </span>
                              ) : (
                                <span className="outline-caret-sp" />
                              )}
                              <span
                                className="outline-title"
                                onClick={() => handleOutlineClick(item)}
                              >
                                {item.title}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* 已打开文档 */}
                  <div className="sb-region">
                    <div className="sb-region-head static">
                      <span className="sb-region-title">已打开 · DOCUMENTS ({openFiles.length})</span>
                    </div>
                    <div className="sb-region-body">
                      {openFiles.map((file) => (
                        <div
                          key={file.id}
                          className={`sidebar-doc-item ${file.id === activeFileId ? 'active' : ''}`}
                          onClick={() => setActiveFileId(file.id)}
                          title={file.path || '未保存于磁盘'}
                        >
                          <AppIcon name="file-text" size={14} className="doc-icon-2" />
                          <span className="doc-name">{file.name}{fileConflicts[file.id] ? ' ⚠️' : ''}</span>
                          {file.isModified && <span className="doc-modified-dot" title="未保存更改">•</span>}
                          <button
                            className="doc-close-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseFile(file.id);
                            }}
                            title="关闭文档"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 工作区文件树 */}
                  <div className="sb-region">
                    <div className="sb-region-head static">
                      <span className="sb-region-title">工作区 · WORKSPACE</span>
                      <button className="sb-mini-btn" onClick={handleSelectWorkspace} title="打开本地文件夹作为工作区">
                        <AppIcon name="folder-open" size={13} />
                      </button>
                    </div>
                    <div className="sb-region-body">
                      {workspaceFiles.length === 0 ? (
                        <div className="sidebar-empty-hint">
                          {workspaceDir ? '该文件夹内暂无 Markdown 文件' : '点击上方图标选择本地文件夹'}
                        </div>
                      ) : (
                        <>
                          <div className="sb-ws-root" title={workspaceDir || ''}>
                            {workspaceDir ? workspaceDir.split(/[\\/]/).pop() : ''}
                          </div>
                          {workspaceFiles.map((item) => (
                            <FileTreeNode
                              key={item.path}
                              item={item}
                              level={0}
                              activePath={activeFile?.path || null}
                              expandedDirs={expandedDirs}
                              dirChildrenCache={dirChildrenCache}
                              onToggleDir={handleToggleDirectory}
                              onOpenFile={openFileByPath}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  </div>

                  {/* 最近文件 */}
                  {recentFiles.length > 0 && (
                    <div className="sb-region">
                      <div className="sb-region-head static">
                        <span className="sb-region-title">最近 · RECENT</span>
                      </div>
                      <div className="sb-region-body">
                        {recentFiles.slice(0, 6).map((rf, idx) => (
                          <div key={idx} className="sidebar-doc-item" onClick={() => handleOpenFile(rf.path)} title={rf.path}>
                            <AppIcon name="file-text" size={14} className="doc-icon-2" />
                            <span className="doc-name">{rf.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="sb-foot">
              <span>UTF-8</span>
              <span>{activeFile?.path || '未保存'}</span>
            </div>
          </aside>
        )}

        {isInspectorOpen && !isSourceMode && (
          <aside className="typo-inspector">
            <div className="insp-head">
              <span className="insp-title">排版检查器</span>
              <button className="sb-mini-btn" onClick={() => setIsInspectorOpen(false)} title="关闭">
                <AppIcon name="close" size={13} />
              </button>
            </div>
            <div className="insp-body">
              <div className="insp-group">
                <div className="insp-label">对齐方式</div>
                <div className="typo-radio-toggle">
                  <button
                    className={`typo-radio-btn ${typography.textAlign === 'justify' ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, textAlign: 'justify' }))}
                    title="两端对齐，末行靠左"
                  >
                    <AppIcon name="align-justify" size={14} />
                  </button>
                  <button
                    className={`typo-radio-btn ${typography.textAlign === 'left' ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, textAlign: 'left' }))}
                    title="自然左对齐"
                  >
                    <AppIcon name="align-left" size={14} />
                  </button>
                </div>
              </div>

              <div className="insp-group">
                <div className="insp-label">首行缩进</div>
                <div className="typo-radio-toggle">
                  <button
                    className={`typo-radio-btn ${!typography.firstLineIndent ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, firstLineIndent: false }))}
                  >
                    顶格
                  </button>
                  <button
                    className={`typo-radio-btn ${typography.firstLineIndent ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, firstLineIndent: true }))}
                  >
                    2 字符
                  </button>
                </div>
              </div>

              <div className="insp-group">
                <div className="insp-label">正文字号 <span className="insp-val">{typography.fontSize}px</span></div>
                <input
                  type="range" min={12} max={26} step={1}
                  className="typo-slider"
                  value={typography.fontSize}
                  onChange={(e) => setTypography((t) => ({ ...t, fontSize: Number(e.target.value) }))}
                />
              </div>

              <div className="insp-group">
                <div className="insp-label">行高 <span className="insp-val">{typography.lineHeight}</span></div>
                <input
                  type="range" min={1.4} max={2.5} step={0.05}
                  className="typo-slider"
                  value={typography.lineHeight}
                  onChange={(e) => setTypography((t) => ({ ...t, lineHeight: Number(e.target.value) }))}
                />
              </div>

              <div className="insp-group">
                <div className="insp-label">段间距 <span className="insp-val">{typography.paragraphMargin}em</span></div>
                <input
                  type="range" min={0.5} max={2.5} step={0.1}
                  className="typo-slider"
                  value={typography.paragraphMargin}
                  onChange={(e) => setTypography((t) => ({ ...t, paragraphMargin: Number(e.target.value) }))}
                />
              </div>

              <div className="insp-group">
                <div className="insp-label">版心宽度</div>
                <select
                  className="typo-select"
                  value={typography.maxWidth}
                  onChange={(e) => setTypography((t) => ({ ...t, maxWidth: e.target.value }))}
                >
                  {MAX_WIDTH_OPTIONS.map((opt, i) => (
                    <option key={i} value={opt.value}>{opt.name}</option>
                  ))}
                </select>
              </div>

              <button
                className="typo-radio-btn insp-reset"
                onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}
                title="恢复默认排版参数"
              >
                恢复默认排版
              </button>
            </div>
          </aside>
        )}

        {/* Main Workspace */}
        <main
          className={`typora-workspace ${isFocusMode ? 'focus-mode-active' : ''} ${isTypewriterMode ? 'typewriter-mode-active' : ''}`}
          style={{ zoom: zoomLevel }}
        >
          {isSourceMode ? (
            /* Pure Source Code Editor */
            <div className="source-fullscreen-pane">
              {caretFlash && (
                <>
                  <div
                    className="source-caret-flash"
                    style={{ top: caretFlash.top, left: caretFlash.left, width: caretFlash.width, height: caretFlash.height }}
                  />
                  <div
                    className="source-caret-tick"
                    style={{ top: caretFlash.top, left: caretFlash.tickLeft, height: caretFlash.height }}
                  />
                </>
              )}
              <textarea
                ref={textareaRef}
                aria-label="Markdown Source Code"
                className="typora-fullscreen-textarea"
                value={activeFile?.content || ''}
                onChange={(e) => {
                  if (caretFlash) setCaretFlash(null);
                  handleContentChange(e.target.value);
                }}
                onKeyUp={() => {
                  if (isTypewriterMode && textareaRef.current) {
                    const ta = textareaRef.current;
                    const cursorIndex = ta.selectionStart;
                    const lines = ta.value.substring(0, cursorIndex).split('\n');
                    const lineIndex = lines.length - 1;
                    const lineHeight = 28;
                    const targetScroll = Math.max(0, lineIndex * lineHeight - ta.clientHeight / 2);
                    ta.scrollTop = targetScroll;
                  }
                }}
                placeholder="在此输入 Markdown 或 LaTeX 公式源码..."
                spellCheck={false}
                autoFocus
              />
            </div>
          ) : (
            /* Pure Typora Centered Article View */
            <div className="typora-document-scroll">
              <div className="typora-paper-article">
                {activeFile?.content?.trim() ? (
                  <article
                    ref={previewRef}
                    className="academic-article"
                    onDoubleClick={handlePreviewDoubleClick}
                  >
                    {renderChunks.map((html, index) => (
                      <div
                        key={index}
                        className="render-chunk"
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    ))}
                  </article>
                ) : (
                  <div
                    className="typora-empty-guide"
                    onClick={() => enterSourceMode(null)}
                  >
                    <p className="empty-hint-main">点击此处或按 <kbd>Ctrl + /</kbd> 开始书写...</p>
                    <p className="empty-hint-sub">也可将 .md 文件拖入窗口，或用顶部 <strong>⋯ 菜单 ➔ 打开文件...</strong> 打开本地 Markdown 文档</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* 4. Typora Bottom Status Bar (Toggleable) */}
      {showStatusBar && (
        <footer className="typora-statusbar">
          <div className="status-left">
            <span
              onClick={() => setShowWordCountModal(true)}
              style={{ cursor: 'pointer', fontWeight: 500 }}
              title="点击查看详细字数与排版统计"
            >
              {metrics.cjkCount + metrics.wordsCount} 字 • {metrics.charWithSpaces} 字符 • {metrics.lines} 行
            </span>
            <span className="sep">•</span>
            <span>预估阅读 ~{metrics.readingMinutes} 分钟</span>
            <span className="sep">•</span>
            <span>{isSourceMode ? '源码模式' : '沉浸排版'}</span>
            {isFocusMode && <><span className="sep">•</span><span className="status-pill-badge">专注模式</span></>}
            {isTypewriterMode && <><span className="sep">•</span><span className="status-pill-badge">打字机模式</span></>}
            {zoomLevel !== 1 && <><span className="sep">•</span><span>缩放: {Math.round(zoomLevel * 100)}%</span></>}
            {renderProgress && (
              <>
                <span className="sep">•</span>
                <span className="status-badge render-progress" title="大文档分段排版中，可继续滚动与编辑">
                  排版中 {renderProgress.done} / {renderProgress.total} 块
                </span>
              </>
            )}
          </div>
          <div className="status-right">
            <span>对齐: {typography.textAlign === 'justify' ? '两端对齐' : '左对齐'}</span>
            <span className="sep">•</span>
            <span>UTF-8</span>
            <span className="sep">•</span>
            <span className="status-badge" onClick={toggleSourceMode} style={{ cursor: 'pointer' }}>
              Ctrl + / 切换
            </span>
          </div>
        </footer>
      )}

            {/* Drag & Drop Visual Feedback Overlay */}
      {isDragging && (
        <div className="drag-drop-overlay">
          <div className="drag-drop-badge">
            <MarkdownXLogo size={36} />
            <span>释放鼠标以打开此 Markdown 文档</span>
            <span className="drag-drop-subtext">支持 .md、.markdown、.txt 文件直接拖入</span>
          </div>
        </div>
      )}

      {/* Word Count Modal (字数统计详细窗口) */}
      {showWordCountModal && (
        <div className="typo-modal-overlay" onClick={() => setShowWordCountModal(false)}>
          <div className="typo-modal-box word-count-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>📊 文档统计与度量 (Word Count & Metrics)</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowWordCountModal(false)}>×</button>
            </div>
            <div className="typo-modal-body">
              <div className="metrics-grid">
                <div className="metric-card">
                  <div className="metric-val">{metrics.cjkCount + metrics.wordsCount}</div>
                  <div className="metric-label">总字数 (中文字 + 英文单词)</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.charWithSpaces}</div>
                  <div className="metric-label">字符数 (计空格)</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.charNoSpaces}</div>
                  <div className="metric-label">字符数 (不计空格)</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.lines}</div>
                  <div className="metric-label">总物理行数</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.paragraphs}</div>
                  <div className="metric-label">自然段落数</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">~{metrics.readingMinutes} 分钟</div>
                  <div className="metric-label">预估阅读时间</div>
                </div>
              </div>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowWordCountModal(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Help Modal (快捷键速查手册) */}
      {showHelpModal && (
        <div className="typo-modal-overlay" onClick={() => setShowHelpModal(false)}>
          <div className="typo-modal-box help-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>⌨️ MarkdownX 快捷键速查手册</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowHelpModal(false)}>×</button>
            </div>
            <div className="typo-modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <table className="shortcuts-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1.5px solid var(--border-strong)', textAlign: 'left' }}>
                    <th style={{ padding: '8px' }}>操作功能</th>
                    <th style={{ padding: '8px' }}>快捷键</th>
                    <th style={{ padding: '8px' }}>所属分类</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td style={{ padding: '6px 8px' }}>显示 / 隐藏侧边栏</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + L</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>大纲面板</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 1</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>文档列表</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 2</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>文件树</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 3</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>全文搜索与替换</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + F</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>源代码 / 排版模式切换</td><td style={{ padding: '6px 8px' }}><code>Ctrl + /</code></td><td>编辑模式</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>专注模式</td><td style={{ padding: '6px 8px' }}><code>F8</code></td><td>沉浸写作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>打字机模式</td><td style={{ padding: '6px 8px' }}><code>F9</code></td><td>沉浸写作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>切换全屏</td><td style={{ padding: '6px 8px' }}><code>F11</code></td><td>窗口控制</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>实际大小 (100%)</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 9</code></td><td>视图缩放</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>放大 / 缩小视图</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + = / -</code></td><td>视图缩放</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>应用内标签页切换</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Tab</code></td><td>窗口控制</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>排版与偏好设置</td><td style={{ padding: '6px 8px' }}><code>Ctrl + ,</code></td><td>偏好设置</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>新建 / 打开 / 保存</td><td style={{ padding: '6px 8px' }}><code>Ctrl + N / O / S</code></td><td>文件操作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>另存为</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + S</code></td><td>文件操作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>打印 / 导出 PDF</td><td style={{ padding: '6px 8px' }}><code>Ctrl + P</code></td><td>文件导出</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>开发者工具</td><td style={{ padding: '6px 8px' }}><code>Shift + F12</code></td><td>系统调试</td></tr>
                </tbody>
              </table>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowHelpModal(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LaTeX & Math Help Modal */}
      {showMathHelpModal && (
        <div className="typo-modal-overlay" onClick={() => setShowMathHelpModal(false)}>
          <div className="typo-modal-box help-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>📐 LaTeX 公式与学术排版规范</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowMathHelpModal(false)}>×</button>
            </div>
            <div className="typo-modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={{ lineHeight: 1.7, fontSize: '13.5px' }}>
                <h4 style={{ margin: '8px 0 4px', color: 'var(--color-primary)' }}>1. 行内数学公式</h4>
                <p>使用单美元符包裹：<code>{'$E = mc^2$'}</code> 或 <code>{'$\sigma_{ij} = C_{ijkl} \varepsilon_{kl}$'}</code></p>
                <h4 style={{ margin: '14px 0 4px', color: 'var(--color-primary)' }}>2. 独立块级公式</h4>
                <p>使用双美元符包裹，并可附加 <code>\tag&#123;1&#125;</code> 编号：</p>
                <pre style={{ background: 'var(--bg-code)', padding: '8px 12px', borderRadius: '4px' }}>
{`$$
\nabla \cdot \boldsymbol{\sigma} + \mathbf{b} = \rho \ddot{\mathbf{u}} \tag{1}
$$`}
                </pre>
                <h4 style={{ margin: '14px 0 4px', color: 'var(--color-primary)' }}>3. 学术三线表 (Booktabs)</h4>
                <p>标准 Markdown 表格会自动以出版级三线表规范呈现：顶底为 2.2px 加粗线，表头下方为 1.2px 细线。</p>
              </div>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowMathHelpModal(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About Modal — version, release notes, licence, build date, tech stack */}
      {showAboutModal && (
        <div className="typo-modal-overlay" onClick={() => setShowAboutModal(false)}>
          <div className="typo-modal-box about-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>关于 MarkdownX</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowAboutModal(false)}>×</button>
            </div>
            <div className="typo-modal-body about-body">
              <div className="about-head">
                <MarkdownXLogo size={52} />
                <h2 className="about-name">MarkdownX</h2>
                <p className="about-version">
                  <strong>{APP_VERSION}</strong>
                  <span className="about-dim"> · 构建于 {APP_BUILD_DATE}</span>
                </p>
                <p className="about-tagline">
                  专为计算力学与科研论文打造的轻量级 Markdown 写作软件。<br />
                  支持原生公式排版、三线表规范、多级大纲与科研级多格式导出。
                </p>
              </div>

              <div className="about-section-title">本次更新 · {RELEASE_NOTES[0].version}（{RELEASE_NOTES[0].date}）</div>
              <ul className="about-notes">
                {RELEASE_NOTES[0].items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>

              <div className="about-section-title">近期版本</div>
              <div className="about-releases">
                {RELEASE_NOTES.slice(1).map((rel) => (
                  <div key={rel.version} className="about-release">
                    <div className="about-release-head">
                      <span className="about-release-ver">{rel.version}</span>
                      <span className="about-release-date">{rel.date}</span>
                    </div>
                    <ul className="about-notes">
                      {rel.items.map((it, i) => (
                        <li key={i}>{it}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="about-meta">
                <div className="about-meta-row">
                  <span className="about-meta-key">许可证</span>
                  <span className="about-meta-val">{APP_LICENSE}</span>
                </div>
                <div className="about-meta-row">
                  <span className="about-meta-key">更新时间</span>
                  <span className="about-meta-val">{APP_BUILD_DATE}</span>
                </div>
                <div className="about-meta-row">
                  <span className="about-meta-key">技术栈</span>
                  <span className="about-meta-val">{APP_TECH}</span>
                </div>
              </div>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowAboutModal(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Detailed Typography Configuration Modal */}
      {showTypographyModal && (
        <div className="typo-modal-overlay" onClick={() => setShowTypographyModal(false)}>
          <div className="typo-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>{settingsModalView === 'preferences' ? '⚙️ 偏好设置 (Preferences)' : '⚙️ 自定义排版与字体设置 (Typography)'}</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowTypographyModal(false)}>
                ×
              </button>
            </div>

            <div className="typo-modal-body">
              {/* Group 1: 字体配置 (typography view only) */}
              {settingsModalView === 'typography' && (<>
              <div className="typo-config-group">
                <div className="typo-group-title">字体族选择 (Typography Families)</div>
                
                <div className="typo-row">
                  <span className="typo-label">西文字体族 (Latin):</span>
                  <select
                    className="typo-select"
                    value={typography.latinFont}
                    onChange={(e) => setTypography((t) => ({ ...t, latinFont: e.target.value }))}
                  >
                    {LATIN_FONT_OPTIONS.map((opt, i) => (
                      <option key={i} value={opt.value}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="typo-row">
                  <span className="typo-label">中文字体族 (CJK):</span>
                  <select
                    className="typo-select"
                    value={typography.cjkFont}
                    onChange={(e) => setTypography((t) => ({ ...t, cjkFont: e.target.value }))}
                  >
                    {CJK_FONT_OPTIONS.map((opt, i) => (
                      <option key={i} value={opt.value}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Group 2: 字号与行距 */}
              <div className="typo-config-group">
                <div className="typo-group-title">字号与间距 (Size & Spacing)</div>
                
                <div className="typo-row">
                  <span className="typo-label">正文字号 (Font Size):</span>
                  <div className="typo-input-control">
                    <input
                      type="range"
                      min={12}
                      max={26}
                      step={1}
                      className="typo-slider"
                      value={typography.fontSize}
                      onChange={(e) => setTypography((t) => ({ ...t, fontSize: Number(e.target.value) }))}
                    />
                    <span className="typo-val-badge">{typography.fontSize}px</span>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">段落行高 (Line Height):</span>
                  <div className="typo-input-control">
                    <input
                      type="range"
                      min={1.4}
                      max={2.5}
                      step={0.05}
                      className="typo-slider"
                      value={typography.lineHeight}
                      onChange={(e) => setTypography((t) => ({ ...t, lineHeight: Number(e.target.value) }))}
                    />
                    <span className="typo-val-badge">{typography.lineHeight}</span>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">段间距 (Paragraph Margin):</span>
                  <div className="typo-input-control">
                    <input
                      type="range"
                      min={0.5}
                      max={2.5}
                      step={0.1}
                      className="typo-slider"
                      value={typography.paragraphMargin}
                      onChange={(e) => setTypography((t) => ({ ...t, paragraphMargin: Number(e.target.value) }))}
                    />
                    <span className="typo-val-badge">{typography.paragraphMargin}em</span>
                  </div>
                </div>
              </div>

              </>)}

              {/* Group 4: 程序默认启动行为配置 (preferences view only) */}
              {settingsModalView === 'preferences' && (<>
              <div className="typo-config-group">
                <div className="typo-group-title">程序默认启动设置 (Default Startup Settings)</div>
                
                <div className="typo-row">
                  <span className="typo-label">启动默认主题 (Default Theme):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'auto' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('auto'); setThemePref('auto'); }}
                      title="跟随操作系统：系统浅色→纯白，系统深色→极客深色"
                    >
                      🖥️ 跟随系统
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'light' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('light'); setThemePref('light'); }}
                    >
                      ☀️ 纯白
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'dark' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('dark'); setThemePref('dark'); }}
                    >
                      🌙 深色
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'sepia' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('sepia'); setThemePref('sepia'); }}
                    >
                      📜 原木
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">启动默认视图 (Default View):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultModeSetting === 'typora' ? 'active' : ''}`}
                      onClick={() => setDefaultModeSetting('typora')}
                    >
                      沉浸排版模式
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultModeSetting === 'source' ? 'active' : ''}`}
                      onClick={() => setDefaultModeSetting('source')}
                    >
                      纯源码模式
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">公式渲染引擎 (Math Engine): <span style={{ fontSize: "11px", color: "#10b981", fontWeight: 600 }}>[已支持离线打包]</span></span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultMathEngineSetting === 'svg' ? 'active' : ''}`}
                      onClick={() => {
                        setDefaultMathEngineSetting('svg');
                        try {
                          localStorage.setItem('markdownx_math_engine', 'svg');
                          setModalFeedback('✓ 已设为【矢量 SVG 模式】（默认推荐：行内分式不重叠）。');
                        } catch {}
                      }}
                      title="推荐：高保真矢量渲染，行内高分式自然对齐，绝不与上下行文字重叠"
                    >
                      📐 矢量 SVG (默认推荐)
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultMathEngineSetting === 'chtml' ? 'active' : ''}`}
                      onClick={() => {
                        setDefaultMathEngineSetting('chtml');
                        try {
                          localStorage.setItem('markdownx_math_engine', 'chtml');
                          setModalFeedback('✓ 已设为【高速 CHTML 模式】（体积仅 1MB，极速启动秒开）。');
                        } catch {}
                      }}
                      title="高速秒开：仅 1.1MB，加载极快，纯轻量级渲染"
                    >
                      ⚡ 高速 CHTML
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">外部修改监控 (File Watcher): <span style={{ fontSize: "11px", color: "#10b981", fontWeight: 600 }}>[Rust 原生]</span></span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${autoWatchSetting ? 'active' : ''}`}
                      onClick={() => {
                        setAutoWatchSetting(true);
                        setModalFeedback('✓ 已开启外部文件变更监控（实时感知外部修改与防冲突保护）。');
                      }}
                      title="实时监控已打开文件的磁盘变动，无修改时自动重载，有修改时弹出防冲突提示"
                    >
                      🟢 开启实时监控 (推荐)
                    </button>
                    <button
                      className={`typo-radio-btn ${!autoWatchSetting ? 'active' : ''}`}
                      onClick={() => {
                        setAutoWatchSetting(false);
                        setModalFeedback('✓ 已关闭外部文件变更监控。');
                      }}
                      title="关闭对外部磁盘文件变动的实时监听"
                    >
                      ⚪ 关闭监控
                    </button>
                  </div>
                </div>
              </div>

              </>)}

              {/* Feedback toast banner */}
              {modalFeedback && (
                <div style={{
                  padding: '8px 14px',
                  backgroundColor: '#ecfdf5',
                  color: '#065f46',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid #a7f3d0',
                  textAlign: 'center'
                }}>
                  {modalFeedback}
                </div>
              )}

              {/* Group 3: 段落版式与对齐 (typography view only) */}
              {settingsModalView === 'typography' && (<>
              <div className="typo-config-group">
                <div className="typo-group-title">段落排版格式 (Paragraph Formatting)</div>

                <div className="typo-row">
                  <span className="typo-label">文本对齐方式 (Align):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${typography.textAlign === 'justify' ? 'active' : ''}`}
                      onClick={() => setTypography((t) => ({ ...t, textAlign: 'justify' }))}
                      title="两端齐行，末行强制左对齐（解决尾行大间距）"
                    >
                      两端对齐 (末行靠左)
                    </button>
                    <button
                      className={`typo-radio-btn ${typography.textAlign === 'left' ? 'active' : ''}`}
                      onClick={() => setTypography((t) => ({ ...t, textAlign: 'left' }))}
                      title="自然左对齐，完全杜绝拉伸间距"
                    >
                      自然左对齐
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">首行缩进 (Indent):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${!typography.firstLineIndent ? 'active' : ''}`}
                      onClick={() => setTypography((t) => ({ ...t, firstLineIndent: false }))}
                    >
                      无缩进 (顶格)
                    </button>
                    <button
                      className={`typo-radio-btn ${typography.firstLineIndent ? 'active' : ''}`}
                      onClick={() => setTypography((t) => ({ ...t, firstLineIndent: true }))}
                    >
                      缩进 2 字符 (2em)
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">版心最大宽度 (Max Width):</span>
                  <select
                    className="typo-select"
                    value={typography.maxWidth}
                    onChange={(e) => setTypography((t) => ({ ...t, maxWidth: e.target.value }))}
                  >
                    {MAX_WIDTH_OPTIONS.map((opt, i) => (
                      <option key={i} value={opt.value}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              </>)}
            </div>

            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                className="typora-btn"
                style={{ color: '#ef4444' }}
                onClick={handleResetFactoryDefaults}
                title="清除所有自定义偏好，重置为出厂设置"
              >
                🔄 恢复出厂设置
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="typora-btn"
                  onClick={handleSaveAsProgramDefaults}
                  title="将当前选定的字体、字号、排版参数及主题固化为软件启动时的全局默认配置"
                >
                  ⭐ 设为程序默认值
                </button>
                <button
                  className="typora-btn typora-btn-primary"
                  onClick={() => setShowTypographyModal(false)}
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
