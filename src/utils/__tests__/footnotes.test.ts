import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderMarkdownPayload } from '../markdownRenderer';

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

/**
 * 脚注区的位置（footnotePlacement）。
 *
 * 默认必须是历史行为：不传参数时输出逐字节不变，所以下面第一条既断言「就地展开」这件事，
 * 又用一条逐字节相等把向后兼容钉死。'end' 只改变「脚注区放在哪里」，编号规则、上标回链、
 * 未解析标记的处理全部与 inline 相同。
 */
describe('A 层 · 脚注位置可配', () => {
  const doc = '第一段[^1]。\n\n[^1]: 脚注内容\n\n第二段。\n';

  it('默认（不传选项）仍是 inline：定义就地展开', async () => {
    const html = await renderMarkdown(doc, '');
    expect(html).toContain('id="fn-1"');
    expect(html.indexOf('id="fn-1"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="fn-1"')).toBeLessThan(html.indexOf('第二段。'));
  });

  it("显式 'inline' 与不传参数逐字节一致（向后兼容）", async () => {
    const implicit = await renderMarkdown(doc, '');
    const explicit = await renderMarkdown(doc, '', {}, { footnotePlacement: 'inline' });
    const empty = await renderMarkdown(doc, '', {}, {});
    expect(explicit).toBe(implicit);
    expect(empty).toBe(implicit);
  });

  it("'end'：正文只留上标回链，脚注区收集到文末一次输出", async () => {
    const html = await renderMarkdown(doc, '', {}, { footnotePlacement: 'end' });
    expect(refs(html)).toBe(1);
    expect(html).toContain('href="#fn-1"');
    expect(html).toContain('id="fn-1"');
    expect(html).toContain('class="fn-back"');
    expect(html).toContain('脚注内容');
    // 定义处不再展开：脚注区排在正文最后一个段落之后
    expect(html.indexOf('id="fn-1"')).toBeGreaterThan(html.indexOf('第二段。'));
    // 分隔线只出现一次（而不是每个定义各一条）
    expect((html.match(/footnotes-sep/g) || []).length).toBe(1);
  });

  it("'end'：编号仍按正文首次引用顺序，脚注区按编号排序", async () => {
    const html = await renderMarkdown('先引 b[^b]，再引 a[^a]。\n\n[^a]: 甲\n\n[^b]: 乙\n', '', {}, {
      footnotePlacement: 'end'
    });
    const b = html.indexOf('<strong>1.</strong> 乙');
    const a = html.indexOf('<strong>2.</strong> 甲');
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(b);
  });

  it("'end'：脚注体里的公式与行内代码照常渲染", async () => {
    const html = await renderMarkdown('正文[^1]。\n\n[^1]: 见 $a=b$ 与 `code`\n', '', {}, {
      footnotePlacement: 'end'
    });
    expect(html).toContain('math-inline');
    expect(html).toContain('<code>code</code>');
    expect(html.indexOf('math-inline')).toBeGreaterThan(html.indexOf('正文'));
  });

  it("'end'：未引用/未定义的处理与 inline 一致（不静默删除作者文字）", async () => {
    const unused = await renderMarkdown('正文。\n\n[^unused]: 没人引用我\n', '', {}, { footnotePlacement: 'end' });
    expect(unused).toContain('[^unused]: 没人引用我');
    expect(refs(unused)).toBe(0);
    expect(unused).not.toContain('footnotes-sep');
    const missing = await renderMarkdown('这里引用了[^nope]。\n', '', {}, { footnotePlacement: 'end' });
    expect(missing).toContain('[^nope]');
  });

  it("'end'：文档以围栏代码块结尾时脚注区仍在代码块之后", async () => {
    const html = await renderMarkdown('正文[^1]。\n\n[^1]: 脚注\n\n```\ncode block\n```\n', '', {}, {
      footnotePlacement: 'end'
    });
    expect(html.indexOf('id="fn-1"')).toBeGreaterThan(html.indexOf('language-plaintext'));
  });

  it('两条渲染路径接受同一份选项且输出一致', async () => {
    const options = { footnotePlacement: 'end' as const };
    const main = await renderMarkdown(doc, '', {}, options);
    const worker = await renderMarkdownPayload(doc, {}, options);
    expect(worker).toBe(main);
  });

  it('经 ctx 下发（Worker 通道只转发 ctx）与显式选项等价', async () => {
    const main = await renderMarkdown(doc, '', {}, { footnotePlacement: 'end' });
    const viaCtx = await renderMarkdownPayload(doc, { footnotePlacement: 'end' });
    expect(viaCtx).toBe(main);
  });
});
