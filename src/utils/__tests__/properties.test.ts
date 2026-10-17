import { describe, it, expect } from 'vitest';
import { parseFrontmatter, buildPropertiesCard } from '../properties';

describe('B 层 · frontmatter 解析（纯函数）', () => {
  it('文本 / 数字 / 布尔 / 日期 的类型判定', () => {
    const props = parseFrontmatter('title: 板壳理论\nversion: 2\nratio: 0.75\ndraft: true\ndate: 2026-10-17\n');
    expect(props.map((p) => [p.key, p.kind])).toEqual([
      ['title', 'text'], ['version', 'number'], ['ratio', 'number'],
      ['draft', 'checkbox'], ['date', 'date'],
    ]);
  });

  it('行内列表与块状列表都能解析', () => {
    const inline = parseFrontmatter('tags: [力学, 板壳]\n');
    expect(inline[0].kind).toBe('tags');
    expect(inline[0].items).toEqual(['力学', '板壳']);
    const block = parseFrontmatter('authors:\n  - 甲\n  - 乙\naliases:\n  - 别名\n');
    expect(block[0].key).toBe('authors');
    expect(block[0].kind).toBe('list');
    expect(block[0].items).toEqual(['甲', '乙']);
    expect(block[1].key).toBe('aliases');
  });

  it('引号会被剥掉，注释行与空行被跳过', () => {
    const props = parseFrontmatter('# 注释\n\ntitle: "带 空格 的标题"\nsubtitle: \'单引号\'\n');
    expect(props[0].value).toBe('带 空格 的标题');
    expect(props[1].value).toBe('单引号');
    expect(props.length).toBe(2);
  });

  it('不成形的行被忽略而不是猜解，且不产生空属性', () => {
    const props = parseFrontmatter('这不是键值对\n: 没有键\nok: yes\n');
    expect(props.map((p) => p.key)).toEqual(['ok']);
  });

  it('空块解析出 0 条 —— 调用方据此决定"原样保留"', () => {
    expect(parseFrontmatter('').length).toBe(0);
    expect(parseFrontmatter('\n\n').length).toBe(0);
  });
});

describe('B 层 · 属性卡渲染', () => {
  it('值一律转义（属性里不渲染 Markdown，官方明确限制）', () => {
    const html = buildPropertiesCard(parseFrontmatter('title: <img src=x onerror=alert(1)>\nnote: **不加粗**\n'));
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).toContain('**不加粗**');
  });

  it('title/author/date 同时写进 data-prop-* 供导出与打印取用', () => {
    const html = buildPropertiesCard(parseFrontmatter('title: 板壳理论\nauthor: 甲\ndate: 2026-10-17\n'));
    expect(html).toContain('data-prop-title="板壳理论"');
    expect(html).toContain('data-prop-author="甲"');
    expect(html).toContain('data-prop-date="2026-10-17"');
  });

  it('标签与列表渲染成 chip，布尔渲染成 是/否', () => {
    const html = buildPropertiesCard(parseFrontmatter('tags: [力学]\ndraft: false\n'));
    expect(html).toContain('props-chip');
    expect(html).toContain('#力学');
    expect(html).toContain('否 (false)');
  });
});
