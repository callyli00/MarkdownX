import { describe, it, expect } from 'vitest';
import {
  extractFrontmatterBlock, readProperties, propertyValue, stripFrontmatter, escapeLatex,
} from '../properties';

const DOC = '---\ntitle: 板的弯曲理论\nauthor: 甲\ndate: 2026-10-17\n---\n\n# 正文\n\n段落。\n';

describe('B 层 · 导出元数据', () => {
  it('取出 frontmatter 块；没有 / 未闭合时为 null', () => {
    expect(extractFrontmatterBlock(DOC)).toContain('title: 板的弯曲理论');
    expect(extractFrontmatterBlock('# 直接正文\n')).toBe(null);
    expect(extractFrontmatterBlock('---\ntitle: 没闭合\n\n正文\n')).toBe(null);
  });

  it('属性查找大小写不敏感', () => {
    const props = readProperties(DOC);
    expect(propertyValue(props, 'title')).toBe('板的弯曲理论');
    expect(propertyValue(props, 'TITLE')).toBe('板的弯曲理论');
    expect(propertyValue(props, 'missing')).toBe('');
  });

  it('CRLF 文档同样能解析', () => {
    const crlf = '---\r\ntitle: 甲\r\n---\r\n\r\n正文\r\n';
    expect(propertyValue(readProperties(crlf), 'title')).toBe('甲');
    expect(stripFrontmatter(crlf).startsWith('正文')).toBe(true);
  });

  it('stripFrontmatter 剥掉 frontmatter，但正文一字不动', () => {
    const out = stripFrontmatter(DOC);
    expect(out).not.toContain('title:');
    expect(out).toContain('# 正文');
    expect(out).toContain('段落。');
  });

  it('stripFrontmatter 不去动"看起来像但没解析出属性"的块', () => {
    const weird = '---\n---\n\n正文\n';
    expect(stripFrontmatter(weird)).toBe(weird);
    const unclosed = '---\ntitle: 没闭合\n\n正文\n';
    expect(stripFrontmatter(unclosed)).toBe(unclosed);
  });

  it('LaTeX 转义：特殊字符必须被中和，否则导出文档会变义', () => {
    expect(escapeLatex('100% 的_a & b')).toBe('100\\% 的\\_a \\& b');
    expect(escapeLatex('a#b$c{d}e^f~g\\h')).toBe('a\\#b\\$c\\{d\\}e\\^f\\~g\\\\h');
    expect(escapeLatex('普通中文标题')).toBe('普通中文标题');
  });
});
