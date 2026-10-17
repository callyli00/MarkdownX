import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdownRenderer';

/**
 * A layer: footnotes.
 *
 * The two rules that matter and are asserted here: numbering follows the ORDER OF FIRST
 * REFERENCE (not the order definitions appear in), and nothing the author wrote is ever
 * silently dropped - unreferenced definitions and undefined references both survive.
 */
const refs = (html: string) => (html.match(/class="fn-ref"/g) || []).length;

describe('A 层 · 脚注 [^label]', () => {
  it('引用变上标链接，定义变编号段落且带回链', async () => {
    const html = await renderMarkdown('正文[^1]。\n\n[^1]: 脚注内容\n', '');
    expect(refs(html)).toBe(1);
    expect(html).toContain('href="#fn-1"');
    expect(html).toContain('id="fn-1"');
    expect(html).toContain('脚注内容');
    expect(html).toContain('class="fn-back"');
  });

  it('按首次引用顺序编号，与定义的书写顺序无关', async () => {
    const html = await renderMarkdown('先引 b[^b]，再引 a[^a]。\n\n[^a]: 甲\n\n[^b]: 乙\n', '');
    const b = html.indexOf('href="#fn-1"');
    const a = html.indexOf('href="#fn-2"');
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(b);
  });

  it('同一标签引用两次：编号一致且不产生重复 id', async () => {
    const html = await renderMarkdown('一次[^x] 两次[^x]。\n\n[^x]: 说明\n', '');
    expect(refs(html)).toBe(2);
    expect((html.match(/id="fnref-1"/g) || []).length).toBe(1);
    expect((html.match(/#fn-1/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('围栏代码块里的脚注语法不动', async () => {
    const html = await renderMarkdown('```\n[^1]: not a footnote\n```\n', '');
    expect(refs(html)).toBe(0);
    expect(html).toContain('[^1]: not a footnote');
  });

  it('公式里的脚注语法不动（数学先于脚注处理）', async () => {
    const html = await renderMarkdown('$a[^1]$ 与正文\n\n[^1]: x\n', '');
    expect(refs(html)).toBe(0);
  });

  it('未被引用的定义保持原样，不静默删除作者文字', async () => {
    const html = await renderMarkdown('正文。\n\n[^unused]: 没人引用我\n', '');
    expect(html).toContain('[^unused]: 没人引用我');
    expect(refs(html)).toBe(0);
  });

  it('没有定义的引用保持原样', async () => {
    const html = await renderMarkdown('这里引用了[^nope]。\n', '');
    expect(html).toContain('[^nope]');
    expect(refs(html)).toBe(0);
  });

  it('多行定义（缩进续行）整体收进脚注', async () => {
    const html = await renderMarkdown('正文[^m]。\n\n[^m]: 第一行\n  第二行\n', '');
    expect(html).toContain('第一行');
    expect(html).toContain('第二行');
  });

  it('注释里的脚注引用不生效（注释先处理）', async () => {
    const html = await renderMarkdown('正文 %%[^1] 在注释里%% 结束\n\n[^1]: x\n', '');
    expect(refs(html)).toBe(0);
  });

  it('脚注定义里可以有公式与行内代码', async () => {
    const html = await renderMarkdown('正文[^1]。\n\n[^1]: 见 $a=b$ 与 `code`\n', '');
    expect(html).toContain('math-inline');
    expect(html).toContain('code');
  });
});
