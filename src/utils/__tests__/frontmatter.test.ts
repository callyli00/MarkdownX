import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdownRenderer';

/**
 * B layer, integration: the frontmatter block must never reach the Markdown parser.
 *
 * `---` + `title: x` + `---` is a legal SETEXT HEADING, so leaving this to marked turns a
 * document's properties into an <h2> and a stray <hr>. The first test below is that exact
 * failure mode as a regression guard.
 */
const card = (html: string) => /class="props-card"/.test(html);

describe('B 层 · frontmatter 接入渲染管线', () => {
  it('顶部 frontmatter 变成属性卡，而不是 setext 标题 + 分隔线', async () => {
    const md = '---\ntitle: 板的弯曲理论\nauthor: 某作者\ntags: [力学, 板壳]\n---\n\n# 正文标题\n\n段落。\n';
    const html = await renderMarkdown(md, '');
    expect(card(html)).toBe(true);
    expect(html).not.toMatch(/<h2[^>]*>title:/);
    expect(html).toContain('板的弯曲理论');
    expect(html).toContain('某作者');
    expect(html).toContain('力学');
    expect(html).toContain('正文标题');
    expect(html).toContain('段落。');
  });

  it('属性值不被 A 层改写（值是数据，不是正文）', async () => {
    const md = '---\ntitle: 含 ==等号== 与 [^1] 的标题\n---\n\n正文[^1]\n\n[^1]: 脚注\n';
    const html = await renderMarkdown(md, '');
    expect(card(html)).toBe(true);
    expect(html).toContain('==等号==');       // 未被高亮
    expect(html).toContain('[^1]');           // 未被当成脚注引用
  });

  it('不在文档开头的 --- 仍是分隔线 / 标题下划线', async () => {
    const html = await renderMarkdown('段落一\n\n---\n\n段落二\n', '');
    expect(card(html)).toBe(false);
    expect(html).toMatch(/<hr\b/);
  });

  it('没有 frontmatter 的文档完全不受影响', async () => {
    const html = await renderMarkdown('# 标题\n\n正文。\n', '');
    expect(card(html)).toBe(false);
    expect(html).toContain('标题');
  });

  it('未闭合的 frontmatter 不吞文档（作者文字必须原样保留）', async () => {
    const html = await renderMarkdown('---\ntitle: 没闭合\n\n# 正文\n', '');
    expect(html).toContain('正文');
    expect(html).toContain('没闭合');
  });

  it('空 frontmatter 块不产生空卡片，文字原样保留', async () => {
    const html = await renderMarkdown('---\n---\n\n正文。\n', '');
    expect(card(html)).toBe(false);
    expect(html).toContain('正文');
  });

  it('代码块里的 --- 与键值行不受影响', async () => {
    const md = '```yaml\n---\ntitle: 示例\n---\n```\n\n正文\n';
    const html = await renderMarkdown(md, '');
    expect(card(html)).toBe(false);
    expect(html).toContain('title: 示例');
  });
});
