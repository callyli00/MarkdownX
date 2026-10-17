import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdownRenderer';

/**
 * A layer: Obsidian-style inline extensions (highlight `==x==`, comment `%%x%%`).
 *
 * Both are source-level passes that run while fenced blocks, inline code spans and every
 * formula are still masked. The protection is therefore structural, not a guard clause —
 * these tests assert that property so a future refactor that moves the passes after the
 * unmask step fails here instead of in a user's document.
 */
const marks = (html: string) => (html.match(/class="md-mark"/g) || []).length;

describe('A 层 · 高亮 ==…==', () => {
  it('普通高亮渲染成 <mark class="md-mark">', async () => {
    const html = await renderMarkdown('这里有 ==重点结论== 需要记住。\n', '');
    expect(html).toContain('<mark class="md-mark">重点结论</mark>');
    expect(marks(html)).toBe(1);
  });

  it('行内公式里的 == 不受影响（公式是哨兵，触及不到）', async () => {
    const html = await renderMarkdown('条件 $a == b$ 成立时。\n', '');
    expect(marks(html)).toBe(0);
    expect(html).toContain('math-inline');
  });

  it('块级公式里的 == 不受影响', async () => {
    const html = await renderMarkdown('$$a == b$$\n', '');
    expect(marks(html)).toBe(0);
    expect(html).toContain('math-equation-row');
  });

  it('围栏代码块里的 == 不受影响', async () => {
    const html = await renderMarkdown('```python\nif a == b:\n    pass\n```\n', '');
    expect(marks(html)).toBe(0);
    expect(html).toContain('a == b');
  });

  it('行内代码里的 == 不受影响', async () => {
    const html = await renderMarkdown('用 `a == b` 判断相等。\n', '');
    expect(marks(html)).toBe(0);
  });

  it('被空格包裹的 == 不当高亮（散文里的比较）', async () => {
    const html = await renderMarkdown('若 a == b 则继续。\n', '');
    expect(marks(html)).toBe(0);
  });

  it('紧贴单词的 == 保持原样（保守：宁可漏标，不可错改正文）', async () => {
    const html = await renderMarkdown('写法 a==b==c 很常见。\n', '');
    expect(marks(html)).toBe(0);
  });

  it('跨行不成对', async () => {
    const html = await renderMarkdown('==开头\n结尾==\n', '');
    expect(marks(html)).toBe(0);
  });

  it('高亮体内允许出现单个 =', async () => {
    const html = await renderMarkdown('标记 ==a=b== 结束。\n', '');
    expect(html).toContain('<mark class="md-mark">a=b</mark>');
  });
});

describe('A 层 · 注释 %%…%%', () => {
  it('注释在预览中消失', async () => {
    const html = await renderMarkdown('正文一。%%这是给自己看的批注%%正文二。\n', '');
    expect(html).not.toContain('这是给自己看的批注');
    expect(html).toContain('正文一');
    expect(html).toContain('正文二');
  });

  it('多行注释整体消失', async () => {
    const html = await renderMarkdown('A\n\n%%第一行\n第二行%%\n\nB\n', '');
    expect(html).not.toContain('第一行');
    expect(html).not.toContain('第二行');
    expect(html).toContain('A');
    expect(html).toContain('B');
  });

  it('围栏里的 %% 保留（Mermaid 的注释语法不能被吃掉）', async () => {
    const md = '```\ngraph TD\n%% mermaid comment\nA-->B\n```\n';
    const html = await renderMarkdown(md, '');
    expect(html).toContain('%% mermaid comment');
  });

  it('公式里的 %% 不受影响', async () => {
    const html = await renderMarkdown('$a \\%% b$\n', '');
    expect(html).toContain('math-inline');
  });

  it('未闭合的 %% 保持原样', async () => {
    const html = await renderMarkdown('折扣是 50%% 不完整\n', '');
    expect(html).toContain('50');
  });

  it('注释先于高亮：注释里的 == 不会变成高亮', async () => {
    const html = await renderMarkdown('正文 %%忽略 ==这里==%% 结束\n', '');
    expect(marks(html)).toBe(0);
    expect(html).not.toContain('这里');
  });
});
