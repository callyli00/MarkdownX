import { describe, it, expect } from 'vitest';
import { buildMenu, clampMenuPosition, isLocalPath, type ContextTarget } from '../contextMenuModel';

const ids = (t: ContextTarget) => buildMenu(t).map((i) => i.id);

describe('buildMenu: tab', () => {
  it('has the four tab actions in order', () => {
    expect(ids({ surface: 'tab' })).toEqual(['tab-close', 'tab-close-others', 'tab-copy-path', 'tab-reveal']);
  });
});

describe('buildMenu: sidebar', () => {
  it('file/doc entries offer open + path actions', () => {
    for (const surface of ['sidebar-file', 'sidebar-doc'] as const) {
      expect(ids({ surface })).toEqual(['file-open', 'file-copy-path', 'file-reveal']);
    }
  });
});

describe('buildMenu: preview', () => {
  it('empty target still gets surface defaults', () => {
    const m = ids({ surface: 'preview' });
    expect(m).toContain('copy-block-md');
    expect(m).toContain('print');
    expect(m).toContain('toggle-view');
  });
  it('selection adds copy-selection first', () => {
    const m = buildMenu({ surface: 'preview', selectedText: '应力松弛' });
    expect(m[0].id).toBe('copy-selection');
  });
  it('whitespace-only selection is not a selection', () => {
    expect(ids({ surface: 'preview', selectedText: '   ' })).not.toContain('copy-selection');
  });
  it('link hit adds open+copy link', () => {
    const m = ids({ surface: 'preview', linkHref: 'https://example.com' });
    expect(m).toContain('link-open');
    expect(m).toContain('link-copy');
  });
  it('code hit adds copy-code with the language label', () => {
    const menu = buildMenu({ surface: 'preview', codeText: 'x=1', codeLang: 'python' });
    const copy = menu.find((i) => i.id === 'code-copy')!;
    expect(copy.label).toContain('python');
    expect(menu.find((i) => i.id === 'open-in-source')!.disabled).toBe(false);
  });
  it('formula hit adds copy-latex', () => {
    expect(ids({ surface: 'preview', latexSource: '$$E=mc^2$$' })).toContain('math-copy-latex');
  });
  it('image on asset:// cannot be revealed', () => {
    const menu = buildMenu({ surface: 'preview', imagePath: 'asset://localhost/x.png' });
    expect(menu.find((i) => i.id === 'img-reveal')!.disabled).toBe(true);
  });
  it('image on a local path can be revealed', () => {
    const menu = buildMenu({ surface: 'preview', imagePath: 'C:/docs/x.png' });
    expect(menu.find((i) => i.id === 'img-reveal')!.disabled).toBe(false);
  });
});

describe('buildMenu: pdf', () => {
  it('page menu has structural ops and print', () => {
    const m = ids({ surface: 'pdf-page', pageIndex: 0, pageCount: 3 });
    for (const id of ['pdf-rotate', 'pdf-insert-after', 'pdf-extract', 'pdf-delete-page', 'pdf-print']) {
      expect(m).toContain(id);
    }
  });
  it('single-page doc cannot delete the page', () => {
    const menu = buildMenu({ surface: 'pdf-page', pageIndex: 0, pageCount: 1 });
    expect(menu.find((i) => i.id === 'pdf-delete-page')!.disabled).toBe(true);
  });
  it('multi-page doc can delete the page', () => {
    const menu = buildMenu({ surface: 'pdf-page', pageIndex: 0, pageCount: 3 });
    expect(menu.find((i) => i.id === 'pdf-delete-page')!.disabled).toBe(false);
  });
  it('selection on pdf adds copy-selection first', () => {
    expect(ids({ surface: 'pdf-page', selectedText: 'abc', pageCount: 2 })[0]).toBe('copy-selection');
  });

  it('with a selection the mark items apply directly to it', () => {
    const menu = buildMenu({ surface: 'pdf-page', pageIndex: 0, pageCount: 3, selectedText: '应力松弛' });
    expect(menu.map((i) => i.id).slice(0, 4)).toEqual([
      'copy-selection', 'pdf-mark-highlight', 'pdf-mark-underline', 'pdf-mark-strikeout',
    ]);
    expect(menu.find((i) => i.id === 'pdf-mark-highlight')!.label).toContain('选中文字');
  });

  it('without a selection the mark items arm the tools (no leading divider)', () => {
    const menu = buildMenu({ surface: 'pdf-page', pageIndex: 0, pageCount: 3 });
    expect(menu[0].id).toBe('pdf-mark-highlight');
    expect(menu[0].dividerBefore).toBeFalsy();
    expect(menu.find((i) => i.id === 'pdf-mark-highlight')!.label).toContain('工具');
  });

  it('pdf menu carries the full annotation tool set', () => {
    const m = ids({ surface: 'pdf-page', pageIndex: 0, pageCount: 3 });
    for (const id of ['pdf-mark-highlight', 'pdf-mark-underline', 'pdf-mark-strikeout', 'pdf-tool-note', 'pdf-tool-ink', 'pdf-tool-eraser']) {
      expect(m).toContain(id);
    }
  });
  it('annot menu deletes; note adds copy-text', () => {
    expect(ids({ surface: 'pdf-annot', annotId: 'a1' })).toEqual(['annot-delete']);
    expect(ids({ surface: 'pdf-annot', annotId: 'a1', annotText: '批注' })).toContain('annot-copy-text');
  });
});

describe('isLocalPath', () => {
  it('rejects urls, accepts windows paths', () => {
    expect(isLocalPath('C:/docs/a.png')).toBe(true);
    expect(isLocalPath('asset://localhost/a.png')).toBe(false);
    expect(isLocalPath('https://x/y.png')).toBe(false);
    expect(isLocalPath('')).toBe(false);
  });
});

describe('clampMenuPosition', () => {
  it('keeps the menu inside the viewport', () => {
    expect(clampMenuPosition(5000, 5000, 220, 260, 1280, 800)).toEqual({ x: 1280 - 220 - 8, y: 800 - 260 - 8 });
    expect(clampMenuPosition(-50, -50)).toEqual({ x: 8, y: 8 });
  });
  it('passes through comfortable positions', () => {
    expect(clampMenuPosition(100, 100, 220, 260, 1280, 800)).toEqual({ x: 100, y: 100 });
  });
});