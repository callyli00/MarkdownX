/**
 * Context-menu model: a pure description of WHAT was right-clicked, and a pure
 * function producing the menu items for it. Keeping this out of App.tsx makes the
 * menu contents unit-testable and stops the render tree from growing nested
 * ternaries per surface.
 *
 * Adding a menu item = one entry here + one dispatch case in App.tsx + one test.
 */

export type ContextSurface =
  | 'tab'            // document tab strip
  | 'preview'        // markdown rendered paper
  | 'sidebar-file'   // workspace file tree entry
  | 'sidebar-doc'    // opened-documents list entry
  | 'pdf-page'       // pdf page background
  | 'pdf-annot';     // an existing annotation

export interface ContextTarget {
  surface: ContextSurface;
  /** Non-empty text selection at right-click time. */
  selectedText?: string;
  /** Hit element info (preview surface). */
  linkHref?: string;
  imagePath?: string;      // resolved local path when known, else the src attribute
  codeText?: string;       // <pre><code> content
  codeLang?: string;
  latexSource?: string;    // formula block's markdown/latex source slice
  /** Tab / sidebar entries: the file this entry refers to. */
  path?: string;
  fileId?: string;
  /** PDF specifics */
  pageIndex?: number;
  annotId?: string;
  annotText?: string;      // note body, for "copy note"
  pageCount?: number;
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;           // emoji, matching the app's existing menu style
  shortcut?: string;
  disabled?: boolean;
  dividerBefore?: boolean;
}

/** asset://, http(s), data and blob URLs are not revealable local paths. */
export function isLocalPath(p: string): boolean {
  return !!p && !/^(asset:|http:|https:|data:|blob:)/i.test(p);
}

/**
 * Build the menu for a target. Order is significant: the most specific action for
 * what was hit comes first (selection > element > surface defaults).
 */
export function buildMenu(t: ContextTarget): MenuItem[] {
  const items: MenuItem[] = [];
  const hasSel = !!t.selectedText && t.selectedText.trim().length > 0;

  switch (t.surface) {
    case 'tab':
      items.push(
        { id: 'tab-close', label: '关闭此标签', icon: '✕', shortcut: 'Ctrl+W' },
        { id: 'tab-close-others', label: '关闭其他标签', icon: '✕✕' },
        { id: 'tab-copy-path', label: '复制完整路径', icon: '⧉', dividerBefore: true, disabled: !t.path },
        { id: 'tab-reveal', label: '在文件夹中显示', icon: '🗀', disabled: !t.path },
      );
      break;

    case 'sidebar-file':
    case 'sidebar-doc':
      items.push(
        { id: 'file-open', label: '打开', icon: '📄' },
        { id: 'file-copy-path', label: '复制完整路径', icon: '⧉', dividerBefore: true },
        { id: 'file-reveal', label: '在文件夹中显示', icon: '🗀' },
      );
      break;

    case 'preview': {
      if (hasSel) items.push({ id: 'copy-selection', label: '复制选中文字', icon: '⧉' });
      if (t.linkHref) {
        items.push(
          { id: 'link-open', label: '打开链接', icon: '🔗' },
          { id: 'link-copy', label: '复制链接地址', icon: '⧉' },
        );
      }
      if (t.imagePath) {
        items.push(
          { id: 'img-copy-path', label: '复制图片路径', icon: '🖼' },
          { id: 'img-reveal', label: '在文件夹中显示', icon: '🗀', disabled: !isLocalPath(t.imagePath) },
        );
      }
      if (t.codeText) {
        items.push({ id: 'code-copy', label: `复制代码${t.codeLang ? ` (${t.codeLang})` : ''}`, icon: '⧉' });
      }
      if (t.latexSource) {
        items.push({ id: 'math-copy-latex', label: '复制 LaTeX 源码', icon: '∑' });
      }
      const canOpenSource = !!(t.latexSource || t.codeText || t.imagePath || hasSel);
      items.push({
        id: 'open-in-source',
        label: '在源码处打开',
        icon: '✎',
        dividerBefore: true,
        disabled: !canOpenSource,
      });
      // surface defaults, always available
      items.push(
        { id: 'copy-block-md', label: '复制此块 (Markdown)', icon: '⬇', dividerBefore: !items.length },
        { id: 'print', label: '打印 / 导出 PDF', icon: '🖨', shortcut: 'Ctrl+P', dividerBefore: true },
        { id: 'export-html', label: '导出 HTML (带样式)', icon: '🌐' },
        { id: 'toggle-view', label: '切换到源码视图', icon: '⇄', shortcut: 'Ctrl+/' },
      );
      break;
    }

    case 'pdf-annot':
      items.push({ id: 'annot-delete', label: '删除此标注', icon: '🗑' });
      if (t.annotText) items.push({ id: 'annot-copy-text', label: '复制便签文字', icon: '⧉' });
      break;

    case 'pdf-page':
      if (hasSel) items.push({ id: 'copy-selection', label: '复制选中文字', icon: '⧉' });
      items.push(
        { id: 'pdf-rotate', label: '旋转此页 90°', icon: '⟳', dividerBefore: hasSel },
        { id: 'pdf-insert-after', label: '在此页后插入空白页', icon: '＋' },
        { id: 'pdf-extract', label: '提取此页另存为…', icon: '⬈' },
        { id: 'pdf-delete-page', label: '删除此页', icon: '🗑', disabled: (t.pageCount ?? 1) <= 1 },
        { id: 'pdf-print', label: '打印整个文档', icon: '🖨', shortcut: 'Ctrl+P', dividerBefore: true },
        { id: 'pdf-zoom-fit', label: '缩放：适合宽度', icon: '⇔' },
        { id: 'pdf-zoom-actual', label: '缩放：实际大小 (100%)', icon: '1:1' },
      );
      break;
  }
  return items;
}

/**
 * Clamp a menu position into the viewport so it never opens off-screen.
 * Defaults approximate the menu's real size; the caller may pass measured values.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menuW = 220,
  menuH = 260,
  viewW = 1280,
  viewH = 800,
  margin = 8
): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, viewW - menuW - margin)),
    y: Math.max(margin, Math.min(y, viewH - menuH - margin)),
  };
}