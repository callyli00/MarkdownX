import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdownRenderer';

/**
 * A layer: callout types and the foldable form.
 *
 * Two things are easy to get wrong here and both are asserted below: an alias must reach
 * one of the colour families that actually exist in App.css (otherwise a callout renders
 * with no style at all), and the fold marker must not survive into the rendered text.
 */
const cards = (html: string) => (html.match(/class="callout-card/g) || []).length;

describe('A 层 · Callout 类型', () => {
  it('Obsidian 别名落在既有配色族上，字面类型保留在 data-callout', async () => {
    const html = await renderMarkdown('> [!info] 别乱动\n> 这是信息。\n', '');
    expect(html).toContain('callout-note');
    expect(html).toContain('data-callout="info"');
    expect(html).toContain('别乱动');
  });

  it('多种别名映射正确', async () => {
    const cases: [string, string][] = [
      ['info', 'callout-note'], ['todo', 'callout-note'], ['quote', 'callout-note'],
      ['hint', 'callout-tip'], ['success', 'callout-tip'], ['example', 'callout-tip'],
      ['attention', 'callout-warning'],
      ['danger', 'callout-important'], ['error', 'callout-important'],
      ['failure', 'callout-important'], ['bug', 'callout-important'],
      ['faq', 'callout-definition'], ['question', 'callout-definition'],
    ];
    for (const [type, cls] of cases) {
      const html = await renderMarkdown(`> [!${type}] t\n> body\n`, '');
      expect(html, `type=${type}`).toContain(cls);
    }
  });

  it('不写标题时用双语默认标题（标题不得跨行偷走正文）', async () => {
    const html = await renderMarkdown('> [!note]\n> 内容\n', '');
    expect(html).toContain('注解 (Note)');
    expect(html).not.toContain('>内容</span>');
    expect(html).toContain('内容');   // 正文仍在
  });

  it('标题在 [type] 同一行时正常取用', async () => {
    const html = await renderMarkdown('> [!note] 我的标题\n> 正文\n', '');
    expect(html).toContain('我的标题');
    expect(html).not.toContain('正文</span>');
  });

  it('原有学术类型是回归保护对象', async () => {
    const html = await renderMarkdown('> [!theorem] 定理一\n> 证明略。\n', '');
    expect(html).toContain('callout-theorem');
    expect(html).toContain('定理一');
  });

  it('大小写不敏感', async () => {
    const html = await renderMarkdown('> [!DANGER] 危险\n> 文本\n', '');
    expect(html).toContain('callout-important');
  });

  it('未知类型退化为 note 且不抛错', async () => {
    const html = await renderMarkdown('> [!whatever] 自定义\n> 文本\n', '');
    expect(html).toContain('callout-card');
    expect(html).toContain('data-callout="whatever"');
  });

  it('普通引用块不受影响', async () => {
    const html = await renderMarkdown('> 这只是一段引用。\n', '');
    expect(html).toMatch(/<blockquote\b/);   // renderer adds data-src-* attributes
    expect(cards(html)).toBe(0);
  });
});

describe('A 层 · Callout 折叠', () => {
  it('[!faq]- 用 <details> 且默认收起', async () => {
    const html = await renderMarkdown('> [!faq]- 常见问题\n> 答案是 42。\n', '');
    expect(html).toContain('<details');
    expect(html).toContain('callout-header');
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  it('[!tip]+ 带 open 属性', async () => {
    const html = await renderMarkdown('> [!tip]+ 展开\n> 内容\n', '');
    expect(html).toMatch(/<details[^>]*\sopen[\s>]/);
    expect(html).toContain('callout-tip');
  });

  it('折叠标记不得漏进正文（标题与首段都不能残留 - 或 +）', async () => {
    const collapsed = await renderMarkdown('> [!faq]- 常见问题\n> 答案是 42。\n', '');
    expect(collapsed).not.toContain('- 常见问题');
    expect(collapsed).not.toMatch(/<p[^>]*>\s*-\s*答案是/);
    const expanded = await renderMarkdown('> [!note]+ 展开的标题\n> 正文\n', '');
    expect(expanded).not.toContain('+ 展开的标题');
    expect(expanded).not.toMatch(/<p[^>]*>\s*\+\s*正文/);
  });
});

describe('A 层 · 任务列表', () => {
  it('复选框渲染且条目文字保留', async () => {
    const html = await renderMarkdown('- [ ] 待办一\n- [x] 已完成\n', '');
    expect((html.match(/type="checkbox"/g) || []).length).toBe(2);
    expect(html).toContain('待办一');
    expect(html).toContain('已完成');
  });
});

describe('A 层 · Callout 嵌套', () => {
  it('两层嵌套：内层是独立卡片且带自己的配色族', async () => {
    const html = await renderMarkdown('> [!note] 外层\n> 外层正文\n> > [!warning] 内层\n> > 内层正文\n', '');
    expect(cards(html)).toBe(2);
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain('callout-note');
    expect(html).toContain('callout-warning');
    // 内层必须真在外层里面：拍平到同级或转义成文本都会让这个顺序断言失败
    expect(html.indexOf('callout-warning')).toBeGreaterThan(html.indexOf('callout-note'));
    expect(html).toContain('外层正文');
    expect(html).toContain('内层正文');
    // 识别词不能漏成可见文本
    expect(html).not.toContain('[!warning]');
  });

  it('三层嵌套（中间层折叠）每层各自一张卡片', async () => {
    const html = await renderMarkdown('> [!note] A\n> > [!warning]- B\n> > > [!tip] C\n> > > C 的正文\n', '');
    expect(cards(html)).toBe(3);
    expect(html).toContain('<details');
    expect(html).toContain('data-callout="tip"');
    expect(html).toContain('callout-tip');
    expect(html).toContain('C 的正文');
    const order = ['callout-note', 'callout-warning', 'callout-tip'].map((cls) => html.indexOf(cls));
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
  });

  it('嵌套内层继续走别名映射（[!hint] → tip 族）', async () => {
    const html = await renderMarkdown('> [!note] 外\n> > [!hint] 内\n> > 内文\n', '');
    expect(cards(html)).toBe(2);
    expect(html).toContain('data-callout="hint"');
    expect(html).toContain('callout-tip');
  });

  it('正文以嵌套卡片开头时不留空段落', async () => {
    const html = await renderMarkdown('> [!note]\n> > [!warning] 内层\n> > 内文\n', '');
    expect(html).toContain('<div class="callout-content"><div class="callout-card callout-warning"');
    expect(html).not.toMatch(/<div class="callout-content">\s*<p><\/p>/);
  });

  it('非法识别词回退成普通引用块（不产生卡片）', async () => {
    // 注意：语法合法但没登记的识别词（如 [!whatever]）仍归 note 族并保留 data-callout，
    // 那条既有行为由上面的「未知类型退化为 note」锁住；这里只管语法本身就非法的输入。
    for (const md of ['> [!1] 不是类型\n> 文本\n', '> [!] 空识别词\n> 文本\n', '> [! ] 空格\n> 文本\n']) {
      const html = await renderMarkdown(md, '');
      expect(cards(html), md).toBe(0);
      expect(html).toMatch(/<blockquote\b/);
      expect(html).not.toContain('callout-header');
    }
  });
});

describe('A 层 · Callout 别名补全', () => {
  it('abstract/summary/tldr/cite/check/done/caution 全部落在既有配色族上', async () => {
    // caution 与 warning 在 App.css 里本来就是同一个选择器（`——.callout-warning, .callout-caution`），
    // 所以把它映射到 warning 族不改变任何视觉效果，只是让别名表和 Obsidian 一致。
    const cases: [string, string][] = [
      ['abstract', 'callout-note'], ['summary', 'callout-note'], ['tldr', 'callout-note'],
      ['cite', 'callout-note'], ['check', 'callout-tip'], ['done', 'callout-tip'],
      ['caution', 'callout-warning'],
    ];
    for (const [type, cls] of cases) {
      const html = await renderMarkdown(`> [!${type}] t\n> body\n`, '');
      expect(html, `type=${type}`).toContain(cls);
      // 字面类型始终原样保留，宿主按它精确定位
      expect(html, `type=${type}`).toContain(`data-callout="${type}"`);
    }
  });
});
