import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { renderMarkdown, triggerMathJax, renderMermaidDiagrams } from './utils/markdownRenderer';
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

const THEME_OPTIONS: { id: AppTheme; name: string; icon: string }[] = [
  { id: 'light', name: '经典纯白学术 (Light)', icon: '☀️' },
  { id: 'dark', name: '夜间极客深色 (Dark)', icon: '🌙' },
  { id: 'sepia', name: '羊皮纸复古原木 (Sepia)', icon: '📜' }
];

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
  defaultTheme: AppTheme;
  defaultViewMode: 'typora' | 'source';
  defaultMathEngine?: 'svg' | 'chtml';
  autoWatchExternalChanges?: boolean;
  defaultTypography: TypographyConfig;
}

const FACTORY_PREFERENCES: AppPreferences = {
  defaultTheme: 'light',
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
        defaultTheme: (oldTheme === 'light' || oldTheme === 'dark' || oldTheme === 'sepia') ? oldTheme : 'light',
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

/** Fold a string for comparison: drop whitespace and Markdown syntax, lower-case. */
export function foldForMatch(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\u00A0') continue;
    if (MATCH_NOISE.test(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

interface SourceIndex {
  /** Source with whitespace and Markdown syntax removed, lower-cased. */
  folded: string;
  /** Original character offset of each character in `folded`. */
  offsets: number[];
}

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
    const probe = probeTextOf(el);
    if (!probe.trim()) continue;
    const at = locateRenderedText(index, probe, cursor);
    if (at === null) continue;
    cursor = at;
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
  const [caretFlash, setCaretFlash] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  // Caret offset to apply when the source view opens, and the position to
  // reveal again when the preview comes back (Typora-style continuity). The
  // restore also records the tab and the exact Markdown it was measured
  // against, so it can never scroll a differently-rendered document.
  const pendingSourceCaretRef = useRef<number | null>(null);
  const pendingPreviewScrollRef = useRef<{ tabId: string; content: string; offset: number } | null>(null);
  
  // Active dropdown menu: null | 'file' | 'edit' | 'format' | 'view' | 'fileList'
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  // Theme state: light | dark | sepia (initialized from user default)
  const [appTheme, setAppTheme] = useState<AppTheme>(() => initialPrefs.current.defaultTheme);
  const [defaultThemeSetting, setDefaultThemeSetting] = useState<AppTheme>(() => initialPrefs.current.defaultTheme);
  const [defaultModeSetting, setDefaultModeSetting] = useState<'typora' | 'source'>(() => initialPrefs.current.defaultViewMode);
  const [defaultMathEngineSetting, setDefaultMathEngineSetting] = useState<'svg' | 'chtml'>(() => initialPrefs.current.defaultMathEngine || 'svg');
  const [autoWatchSetting, setAutoWatchSetting] = useState<boolean>(() => initialPrefs.current.autoWatchExternalChanges !== false);
  const [externalReloadNotice, setExternalReloadNotice] = useState<string | null>(null);
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
  const [sidebarTab, setSidebarTab] = useState<'outline' | 'docs' | 'files' | 'search'>('outline');
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

  useEffect(() => {
    document.body.className = `theme-${appTheme}`;
  }, [appTheme]);

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

  const [renderedHtml, setRenderedHtml] = useState<string>('');
  const previewRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // The Markdown that `renderedHtml` was produced from. Rendering is async, so
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

  const updatePreview = useCallback(async (content: string, currentPath: string | null) => {
    try {
      const basePath = getBasePath(currentPath);
      const html = await renderMarkdown(content, basePath);
      renderedForContentRef.current = content;
      setRenderedHtml(html);
    } catch (error) {
      console.error('Markdown rendering error:', error);
      setRenderedHtml(`<div style="color: #ef4444; padding: 20px;">Rendering Error: ${String(error)}</div>`);
    }
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

  // Prevent MathJax contextmenu and auto-clean any corrupted MathJax localStorage
  useEffect(() => {
    try {
      localStorage.removeItem('mjx.menu');
      localStorage.removeItem('MathJax-Menu-Settings');
    } catch {}

    const handleMathContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target && target.closest('mjx-container, .math-equation-row')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('contextmenu', handleMathContextMenu, true);
    return () => window.removeEventListener('contextmenu', handleMathContextMenu, true);
  }, []);

  // Typeset MathJax whenever rendered HTML updates
  useEffect(() => {
    if (previewRef.current && !isSourceMode) {
      triggerMathJax(previewRef.current);
    }
  }, [renderedHtml, isSourceMode]);

  // Draw ```mermaid diagrams whenever the preview HTML is rebuilt.
  useEffect(() => {
    if (previewRef.current && !isSourceMode) {
      renderMermaidDiagrams(previewRef.current, appTheme);
    }
  }, [renderedHtml, isSourceMode, appTheme]);

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
      const lineHeight = parseFloat(style.lineHeight) || 28;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const lineIndex = ta.value.slice(0, pos).split('\n').length - 1;
      // Absolute placement (not a delta): the target line lands one third down
      // the viewport regardless of any scroll offset the textarea already has.
      ta.scrollTop = Math.max(0, paddingTop + lineIndex * lineHeight - ta.clientHeight / 3);

      // A caret alone is nearly invisible in a wall of text; flash the line it
      // landed on so the jump target is unmistakable.
      const pane = ta.parentElement;
      if (pane) {
        const top = ta.offsetTop + paddingTop + lineIndex * lineHeight - ta.scrollTop;
        setCaretFlash({
          top,
          left: ta.offsetLeft + paddingLeft,
          width: Math.max(0, ta.clientWidth - paddingLeft - paddingRight),
          height: lineHeight
        });
      }
    });
  }, [isSourceMode]);

  // The flash is transient: fade it out on its own, and clear it the moment the
  // writer interacts with the text, so it never lingers as visual noise.
  useEffect(() => {
    if (!caretFlash) return;
    const timer = window.setTimeout(() => setCaretFlash(null), 1600);
    return () => window.clearTimeout(timer);
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
    pendingPreviewScrollRef.current = null;
    const offset = pending.offset;

    const article = previewRef.current;
    const scroller = article?.closest('.typora-document-scroll') as HTMLElement | null;
    const source = activeFile?.content || '';
    if (!article || !scroller || !source) return;

    const target = blockForSourceOffset(article, source, offset);
    if (!target) return;

    // Absolute geometry via rects: offsetTop is unreliable because neither
    // .typora-document-scroll nor .typora-paper-article is positioned.
    const reveal = () => {
      const delta = target!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 24);
    };
    requestAnimationFrame(reveal);
    // Re-apply once the async typesetters have reflowed the article.
    const settle = window.setTimeout(reveal, 350);
    return () => window.clearTimeout(settle);
  }, [isSourceMode, renderedHtml]);

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
      if (textareaRef.current) {
        const lines = (activeFile?.content || '').split('\n');
        let charIndex = 0;
        for (let i = 0; i < item.line && i < lines.length; i++) {
          charIndex += lines[i].length + 1;
        }
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(charIndex, charIndex + (lines[item.line]?.length || 0));
        const lineHeight = 28;
        textareaRef.current.scrollTop = Math.max(0, item.line * lineHeight - 150);
      }
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
        setSidebarTab('files');
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
      const probe = probeTextOf(el);
      if (!probe.trim()) continue;
      const at = locateRenderedText(index, probe, cursor);
      if (at === null) continue;
      cursor = at; // every located block advances the search, skipped or not
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
      if (!target.closest('.menu-item-wrap') && !target.closest('.file-select-dropdown')) {
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
            setIsSidebarOpen(true);
            setSidebarTab('outline');
            return;
          } else if (e.key === '2' || e.key === '@') {
            e.preventDefault();
            setIsSidebarOpen(true);
            setSidebarTab('docs');
            return;
          } else if (e.key === '3' || e.key === '#') {
            e.preventDefault();
            setIsSidebarOpen(true);
            setSidebarTab('files');
            return;
          } else if (e.key === 'F' || e.key === 'f') {
            e.preventDefault();
            setIsSidebarOpen(true);
            setSidebarTab('search');
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
      setAppTheme(FACTORY_PREFERENCES.defaultTheme);
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
    ${renderedHtml}
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
${renderedHtml}
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
    ${renderedHtml}
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
      {/* 1. Typora Native Top Menu Bar (文件, 编辑, 段落/字体, 视图) */}
      <header className="typora-menubar">
        <div className="menubar-left">
          <div className="app-logo-wrap" title="MarkdownX v1.8.4"><MarkdownXLogo size={22} /><span className="app-name-label">MarkdownX</span></div>

          {/* 文件(F) Menu Dropdown */}
          <div className="menu-item-wrap">
            <button
              className={`menu-top-btn ${activeMenu === 'file' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'file' ? null : 'file');
              }}
            >
              文件(F)
            </button>
            {activeMenu === 'file' && (
              <div className="typora-dropdown-menu">
                <div className="dropdown-item" onClick={handleNewFile}>
                  <span>新建</span>
                  <span className="shortcut">Ctrl+N</span>
                </div>
                <div className="dropdown-item" onClick={() => handleOpenFile()}>
                  <span>打开...</span>
                  <span className="shortcut">Ctrl+O</span>
                </div>
                
                {/* Recent files submenu */}
                <div className="dropdown-item has-submenu">
                  <span>打开最近文件</span>
                  <span className="arrow">›</span>
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
                  <span>保存</span>
                  <span className="shortcut">Ctrl+S</span>
                </div>
                <div className="dropdown-item" onClick={handleSaveFileAs}>
                  <span>另存为...</span>
                  <span className="shortcut">Ctrl+Shift+S</span>
                </div>
                <div className="dropdown-divider" />

                {/* 导出 › (Export Submenu - Matches Typora Structure) */}
                <div className="dropdown-item has-submenu">
                  <span>导出</span>
                  <span className="arrow">›</span>
                  <div className="typora-submenu export-submenu">
                    <div className="dropdown-item" onClick={handlePrint}>
                      <span>PDF...</span>
                      <span className="shortcut">出版级</span>
                    </div>
                    <div className="dropdown-item" onClick={handleExportHtmlWithStyles}>
                      <span>HTML (带完整样式)...</span>
                      <span className="shortcut">单文件网页</span>
                    </div>
                    <div className="dropdown-item" onClick={handleExportHtmlPlain}>
                      <span>HTML (without styles)...</span>
                      <span className="shortcut">纯净片段</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div className="dropdown-item" onClick={handleExportWord}>
                      <span>Word (.docx)...</span>
                      <span className="shortcut">微软文档</span>
                    </div>
                    <div className="dropdown-item" onClick={handleExportLatex}>
                      <span>LaTeX (.tex)...</span>
                      <span className="shortcut">学术手稿</span>
                    </div>
                  </div>
                </div>

                {/* 打印... (Print) - Kept 100% Independent! */}
                <div className="dropdown-item" onClick={handlePrint}>
                  <span>打印...</span>
                  <span className="shortcut">Ctrl+P</span>
                </div>

                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { setShowTypographyModal(true); setActiveMenu(null); }}>
                  <span>偏好设置...</span>
                  <span className="shortcut">Ctrl+,</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => handleCloseFile(activeFileId)}>
                  <span>关闭</span>
                  <span className="shortcut">Ctrl+W</span>
                </div>
              </div>
            )}
          </div>

          {/* 编辑(E) Menu */}
          <div className="menu-item-wrap">
            <button
              className={`menu-top-btn ${activeMenu === 'edit' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'edit' ? null : 'edit');
              }}
            >
              编辑(E)
            </button>
            {activeMenu === 'edit' && (
              <div className="typora-dropdown-menu">
                <div className="dropdown-item" onClick={() => document.execCommand('undo')}>
                  <span>撤销</span>
                  <span className="shortcut">Ctrl+Z</span>
                </div>
                <div className="dropdown-item" onClick={() => document.execCommand('redo')}>
                  <span>重做</span>
                  <span className="shortcut">Ctrl+Y</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => document.execCommand('copy')}>
                  <span>复制</span>
                  <span className="shortcut">Ctrl+C</span>
                </div>
                <div className="dropdown-item" onClick={() => document.execCommand('paste')}>
                  <span>粘贴</span>
                  <span className="shortcut">Ctrl+V</span>
                </div>
              </div>
            )}
          </div>

          {/* 段落与格式(O) Menu */}
          <div className="menu-item-wrap">
            <button
              className={`menu-top-btn ${activeMenu === 'format' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'format' ? null : 'format');
              }}
            >
              段落/格式(O)
            </button>
            {activeMenu === 'format' && (
              <div className="typora-dropdown-menu">
                <div className="dropdown-item" onClick={() => { setShowTypographyModal(true); setActiveMenu(null); }}>
                  <span>⚙️ 自定义排版与字体设置...</span>
                  <span className="shortcut">详细</span>
                </div>
                <div className="dropdown-divider" />
                <div className="menu-header-caption">段落对齐方式</div>
                <div className="dropdown-item" onClick={() => setTypography((t) => ({ ...t, textAlign: 'justify' }))}>
                  <span>{typography.textAlign === 'justify' ? '✓ ' : '  '}两端对齐 (末行靠左)</span>
                  <span className="shortcut">学术标准</span>
                </div>
                <div className="dropdown-item" onClick={() => setTypography((t) => ({ ...t, textAlign: 'left' }))}>
                  <span>{typography.textAlign === 'left' ? '✓ ' : '  '}左对齐 (自然排版)</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => setTypography((t) => ({ ...t, firstLineIndent: !t.firstLineIndent }))}>
                  <span>{typography.firstLineIndent ? '✓ ' : '  '}段落首行缩进 2 字符</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => setTypography((t) => ({ ...t, fontSize: Math.min(t.fontSize + 1, 26) }))}>
                  <span>放大字号 ({typography.fontSize}px)</span>
                  <span className="shortcut">Ctrl+=</span>
                </div>
                <div className="dropdown-item" onClick={() => setTypography((t) => ({ ...t, fontSize: Math.max(t.fontSize - 1, 12) }))}>
                  <span>缩小字号</span>
                  <span className="shortcut">Ctrl+-</span>
                </div>
                <div className="dropdown-item" onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}>
                  <span>恢复默认排版参数</span>
                </div>
              </div>
            )}
          </div>

          {/* 视图(V) Menu */}
          <div className="menu-item-wrap">
            <button
              className={`menu-top-btn ${activeMenu === 'view' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'view' ? null : 'view');
              }}
            >
              视图(V)
            </button>
            {activeMenu === 'view' && (
              <div className="typora-dropdown-menu">
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsSidebarOpen((prev) => !prev);
                    setActiveMenu(null);
                  }}
                >
                  <span>{isSidebarOpen ? '✓ 显示 / 隐藏侧边栏' : '显示 / 隐藏侧边栏'}</span>
                  <span className="shortcut">Ctrl+Shift+L</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsSidebarOpen(true);
                    setSidebarTab('outline');
                    setActiveMenu(null);
                  }}
                >
                  <span>大纲</span>
                  <span className="shortcut">Ctrl+Shift+1</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsSidebarOpen(true);
                    setSidebarTab('docs');
                    setActiveMenu(null);
                  }}
                >
                  <span>文档列表</span>
                  <span className="shortcut">Ctrl+Shift+2</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsSidebarOpen(true);
                    setSidebarTab('files');
                    setActiveMenu(null);
                  }}
                >
                  <span>文件树</span>
                  <span className="shortcut">Ctrl+Shift+3</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsSidebarOpen(true);
                    setSidebarTab('search');
                    setActiveMenu(null);
                  }}
                >
                  <span>搜索</span>
                  <span className="shortcut">Ctrl+Shift+F</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    toggleSourceMode();
                    setActiveMenu(null);
                  }}
                >
                  <span>{isSourceMode ? '✓ 源代码模式' : '源代码模式'}</span>
                  <span className="shortcut">Ctrl+/</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsFocusMode((prev) => !prev);
                    setActiveMenu(null);
                  }}
                >
                  <span>{isFocusMode ? '✓ 专注模式' : '专注模式'}</span>
                  <span className="shortcut">F8</span>
                </div>

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setIsTypewriterMode((prev) => !prev);
                    setActiveMenu(null);
                  }}
                >
                  <span>{isTypewriterMode ? '✓ 打字机模式' : '打字机模式'}</span>
                  <span className="shortcut">F9</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowStatusBar((prev) => !prev);
                    setActiveMenu(null);
                  }}
                >
                  <span>{showStatusBar ? '✓ 显示状态栏' : '显示状态栏'}</span>
                </div>

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowWordCountModal(true);
                    setActiveMenu(null);
                  }}
                >
                  <span>字数统计窗口</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    handleToggleFullscreen();
                    setActiveMenu(null);
                  }}
                >
                  <span>{isFullscreen ? '✓ 退出全屏' : '切换全屏'}</span>
                  <span className="shortcut">F11</span>
                </div>

                <div
                  className="dropdown-item"
                  onClick={() => {
                    handleToggleAlwaysOnTop();
                    setActiveMenu(null);
                  }}
                >
                  <span>{isAlwaysOnTop ? '✓ 保持窗口在最前端' : '保持窗口在最前端'}</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setZoomLevel(1.0);
                    setActiveMenu(null);
                  }}
                >
                  <span>{zoomLevel === 1.0 ? '✓ 实际大小' : `实际大小 (${Math.round(zoomLevel * 100)}%)`}</span>
                  <span className="shortcut">Ctrl+Shift+9</span>
                </div>

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setZoomLevel((z) => Math.min(2.0, Number((z + 0.1).toFixed(1))));
                    setActiveMenu(null);
                  }}
                >
                  <span>放大</span>
                  <span className="shortcut">Ctrl+Shift+=</span>
                </div>

                <div
                  className="dropdown-item"
                  onClick={() => {
                    setZoomLevel((z) => Math.max(0.6, Number((z - 0.1).toFixed(1))));
                    setActiveMenu(null);
                  }}
                >
                  <span>缩小</span>
                  <span className="shortcut">Ctrl+Shift+-</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    handleCycleTab();
                    setActiveMenu(null);
                  }}
                >
                  <span>应用内窗口切换</span>
                  <span className="shortcut">Ctrl+Tab</span>
                </div>

                <div className="dropdown-divider" />

                <div
                  className="dropdown-item"
                  onClick={() => {
                    handleOpenDevTools();
                    setActiveMenu(null);
                  }}
                >
                  <span>开发者工具</span>
                  <span className="shortcut">Shift+F12</span>
                </div>
              </div>
            )}
          </div>

          {/* 主题(T) Menu */}
          <div className="menu-item-wrap">
            <button
              className={`menu-top-btn ${activeMenu === 'theme' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'theme' ? null : 'theme');
              }}
            >
              主题(T)
            </button>
            {activeMenu === 'theme' && (
              <div className="typora-dropdown-menu">
                {THEME_OPTIONS.map((thm) => (
                  <div
                    key={thm.id}
                    className="dropdown-item"
                    onClick={() => {
                      setAppTheme(thm.id);
                      setActiveMenu(null);
                    }}
                  >
                    <span>{appTheme === thm.id ? `✓ ${thm.icon} ${thm.name}` : `  ${thm.icon} ${thm.name}`}</span>
                  </div>
                ))}
                <div className="dropdown-divider" />
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowTypographyModal(true);
                    setActiveMenu(null);
                  }}
                >
                  <span>🎨 排版与偏好设置...</span>
                  <span className="shortcut">Ctrl+,</span>
                </div>
              </div>
            )}
          </div>

          {/* 帮助(H) Menu */}
          <div className="menu-item-wrap">
            <button
              className={`menu-top-btn ${activeMenu === 'help' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'help' ? null : 'help');
              }}
            >
              帮助(H)
            </button>
            {activeMenu === 'help' && (
              <div className="typora-dropdown-menu">
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowHelpModal(true);
                    setActiveMenu(null);
                  }}
                >
                  <span>⌨️ 快捷键速查表...</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowMathHelpModal(true);
                    setActiveMenu(null);
                  }}
                >
                  <span>📐 LaTeX 公式与排版指南...</span>
                </div>
                <div className="dropdown-divider" />
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowAboutModal(true);
                    setActiveMenu(null);
                  }}
                >
                  <span>ℹ️ 关于 MarkdownX...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 2. Open Files Dropdown Manager in Header */}
        <div className="menubar-center">
          <div className="file-select-dropdown">
            <button
              className="current-file-btn"
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(activeMenu === 'fileList' ? null : 'fileList');
              }}
              title="点击查看并切换所有已打开的文档"
            >
              <MarkdownXLogo size={16} />
              <span className="current-file-name">
                {activeFile?.name}
                {activeFile?.isModified ? ' •' : ''}
              </span>
              <span className="dropdown-caret">▾</span>
            </button>

            {activeMenu === 'fileList' && (
              <div className="open-files-menu">
                <div className="menu-header-caption">已打开的文档列表 ({openFiles.length})</div>
                {openFiles.map((file) => (
                  <div
                    key={file.id}
                    className={`open-file-item ${file.id === activeFileId ? 'active' : ''}`}
                    onClick={() => {
                      setActiveFileId(file.id);
                      setActiveMenu(null);
                    }}
                  >
                    <div className="item-title-col">
                      <span className="item-name">{file.name}{fileConflicts[file.id] ? ' ⚠️' : ''}</span>
                      <span className="item-path">{file.path || '未保存于磁盘'}</span>
                    </div>
                    <button
                      className="tab-close-btn"
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
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={handleNewFile}>
                  <span>＋ 新建空白文档</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="menubar-right">
          {/* Sidebar quick toggle button */}
          <button
            className={`quick-font-btn ${isSidebarOpen ? 'active' : ''}`}
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            title="显示 / 隐藏侧边栏 (Ctrl + Shift + L)"
          >
            <span>◧ 侧边栏</span>
          </button>

          {/* Quick Theme Switcher Button */}
          <button
            className="quick-font-btn"
            onClick={() => setAppTheme(t => t === 'light' ? 'dark' : (t === 'dark' ? 'sepia' : 'light'))}
            title="一键循环切换主题：纯白 / 夜间深色 / 复古原木"
          >
            <span>{appTheme === 'light' ? '☀️ 浅色' : (appTheme === 'dark' ? '🌙 深色' : '📜 原木')}</span>
          </button>

          <button
            className={`view-mode-toggle-btn ${isSourceMode ? 'active' : ''}`}
            onClick={toggleSourceMode}
            title="一键在 Typora 沉浸排版 与 源码 之间切换 (Ctrl + /)"
          >
            {isSourceMode ? '返回沉浸排版' : '</> 源码模式'}
          </button>
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
            <div className="sidebar-header">
              <div className="sidebar-tabs">
                <button
                  className={`sidebar-tab-btn ${sidebarTab === 'outline' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('outline')}
                  title="大纲目录 (Ctrl+Shift+1)"
                >
                  📑 大纲
                </button>
                <button
                  className={`sidebar-tab-btn ${sidebarTab === 'docs' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('docs')}
                  title="打开文档列表 (Ctrl+Shift+2)"
                >
                  📄 文档
                </button>
                <button
                  className={`sidebar-tab-btn ${sidebarTab === 'files' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('files')}
                  title="目录文件树 (Ctrl+Shift+3)"
                >
                  📁 文件树
                </button>
                <button
                  className={`sidebar-tab-btn ${sidebarTab === 'search' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('search')}
                  title="文档内搜索与替换 (Ctrl+Shift+F)"
                >
                  🔍 搜索
                </button>
              </div>
              <button
                className="sidebar-close-btn"
                onClick={() => setIsSidebarOpen(false)}
                title="关闭侧边栏 (Ctrl+Shift+L)"
              >
                ×
              </button>
            </div>

            <div className="sidebar-content-pane">
              {/* Tab 1: Outline / TOC */}
              {sidebarTab === 'outline' && (
                <div className="outline-view">
                  <div className="sidebar-pane-title">文档大纲 (TOC)</div>
                  {outlineList.length === 0 ? (
                    <div className="sidebar-empty-hint">当前文档暂无标题大纲</div>
                  ) : (
                    outlineList.map((item, idx) => (
                      <div
                        key={idx}
                        className={`outline-item level-${item.level}`}
                        style={{ paddingLeft: `${(item.level - 1) * 12 + 10}px` }}
                        onClick={() => handleOutlineClick(item)}
                        title={`跳转到: ${item.title}`}
                      >
                        <span className="outline-prefix">{'#'.repeat(item.level)}</span>
                        <span className="outline-title">{item.title}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Tab 2: Document List */}
              {sidebarTab === 'docs' && (
                <div className="docs-view">
                  <div className="sidebar-pane-title">打开的文档列表</div>
                  <div className="sidebar-docs-list">
                    {openFiles.map((file) => (
                      <div
                        key={file.id}
                        className={`sidebar-doc-item ${file.id === activeFileId ? 'active' : ''}`}
                        onClick={() => setActiveFileId(file.id)}
                      >
                        <span className="doc-icon">📄</span>
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
                  <button className="sidebar-new-btn" onClick={handleNewFile}>
                    ＋ 新建空白文档
                  </button>
                </div>
              )}

              {/* Tab 3: File Tree (N-level recursive tree) */}
              {sidebarTab === 'files' && (
                <div className="files-view">
                  <div className="files-view-header">
                    <span className="folder-name" title={workspaceDir || '未选择文件夹'}>
                      📁 {workspaceDir ? workspaceDir.split(/[\/]/).pop() : '未选择文件夹'}
                    </span>
                    <button className="folder-open-btn" onClick={handleSelectWorkspace} title="选择本地工作区目录">
                      打开...
                    </button>
                  </div>
                  <div className="file-tree-list">
                    {workspaceFiles.length === 0 ? (
                      <div className="sidebar-empty-hint">
                        {workspaceDir ? '当前文件夹内未发现 Markdown 或支持的文件' : '点击上方“打开...”选择本地文件夹'}
                      </div>
                    ) : (
                      workspaceFiles.map((item) => (
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
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Tab 4: Search & Replace */}
              {sidebarTab === 'search' && (
                <div className="search-view">
                  <div className="sidebar-pane-title">文档全文查找与替换</div>
                  <div className="search-box">
                    <input
                      type="text"
                      className="search-input"
                      placeholder="查找内容..."
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
                </div>
              )}
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
                <div
                  className="source-caret-flash"
                  style={{ top: caretFlash.top, left: caretFlash.left, width: caretFlash.width, height: caretFlash.height }}
                />
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
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    onDoubleClick={handlePreviewDoubleClick}
                  />
                ) : (
                  <div
                    className="typora-empty-guide"
                    onClick={() => enterSourceMode(null)}
                  >
                    <p className="empty-hint-main">点击此处或按 <kbd>Ctrl + /</kbd> 开始书写...</p>
                    <p className="empty-hint-sub">也可通过左上方 <strong>文件(F) ➔ 打开...</strong> 打开本地 Markdown 文档</p>
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

      {/* About Modal */}
      {showAboutModal && (
        <div className="typo-modal-overlay" onClick={() => setShowAboutModal(false)}>
          <div className="typo-modal-box" style={{ maxWidth: '440px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-body" style={{ padding: '32px 24px 24px' }}>
              <MarkdownXLogo size={56} />
              <h2 style={{ margin: '16px 0 8px', fontSize: '20px' }}>MarkdownX</h2>
              <p style={{ color: 'var(--text-faint)', fontSize: '12px', margin: '0 0 16px' }}>v1.8.4 (2026.10)</p>
              <p style={{ fontSize: '13.5px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                专为计算力学与科研论文打造的轻量级纯粹 Markdown 写作软件。<br />
                支持原生公式排版、三线表规范、多级大纲、专注写作及多格式科研级导出。
              </p>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'center' }}>
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
                <span>⚙️ 偏好设置与默认排版配置 (Preferences)</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowTypographyModal(false)}>
                ×
              </button>
            </div>

            <div className="typo-modal-body">
              {/* Group 1: 字体配置 */}
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

              {/* Group 4: 程序默认启动行为配置 */}
              <div className="typo-config-group">
                <div className="typo-group-title">程序默认启动设置 (Default Startup Settings)</div>
                
                <div className="typo-row">
                  <span className="typo-label">启动默认主题 (Default Theme):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'light' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('light'); setAppTheme('light'); }}
                    >
                      ☀️ 纯白
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'dark' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('dark'); setAppTheme('dark'); }}
                    >
                      🌙 深色
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'sepia' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('sepia'); setAppTheme('sepia'); }}
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

              {/* Group 3: 段落版式与对齐 */}
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
