import { describe, it, expect } from 'vitest';
import { setProperty, removeProperty, formatPropertyValue } from '../propertyEdit';

const DOC = '---\ntitle: 旧标题\nauthor: 甲\n# 这行注释必须原样保留\ntags: [a, b]\n---\n\n# 正文\n\n段落一\n段落二\n';

describe('B3 · 写回源码（逐字节保守）', () => {
  it('改一个键：只动那一行，其余一字不差', () => {
    const out = setProperty(DOC, 'title', '新标题', 'text');
    expect(out).toContain('title: 新标题');
    expect(out).not.toContain('旧标题');
    expect(out).toContain('author: 甲');
    expect(out).toContain('# 这行注释必须原样保留');       // 注释行不动
    expect(out).toContain('tags: [a, b]');                 // 别的键不动
    expect(out).toContain('段落一\n段落二');
  });

  it('正文部分严格不变（只替换 frontmatter 段）', () => {
    const body = DOC.slice(DOC.indexOf('---\n\n#') + 4);
    expect(setProperty(DOC, 'title', 'x', 'text').endsWith(body)).toBe(true);
  });

  it('新增不存在的键：追加在块内，不改动原文的其他部分', () => {
    const out = setProperty(DOC, 'date', '2026-10-17', 'date');
    expect(out).toContain('date: 2026-10-17');
    expect(out).toContain('title: 旧标题');
    expect(out.indexOf('date:')).toBeLessThan(out.lastIndexOf('---'));
  });

  it('把块状列表改成行内列表时，旧的 - 项必须被吃掉（不留孤儿项）', () => {
    const src = '---\ntags:\n  - 甲\n  - 乙\n---\n\n正文\n';
    const out = setProperty(src, 'tags', '丙, 丁', 'tags');
    expect(out).toContain('tags: [丙, 丁]');
    expect(out).not.toContain('- 甲');
    expect(out).not.toContain('- 乙');
    expect(out).toContain('正文');
  });

  it('没有 frontmatter 时新建一个块', () => {
    const out = setProperty('# 直接正文\n', 'title', '新文档', 'text');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('title: 新文档');
    expect(out).toContain('# 直接正文');
  });

  it('CRLF 文档保持 CRLF', () => {
    const out = setProperty('---\r\ntitle: 甲\r\n---\r\n\r\n正文\r\n', 'title', '乙', 'text');
    expect(out).toContain('title: 乙');
    expect(out).toContain('\r\n');
  });

  it('删除属性：连它的块状列表项一起删，其余保留', () => {
    const src = '---\ntitle: 甲\ntags:\n  - x\n  - y\nauthor: 乙\n---\n\n正文\n';
    const out = removeProperty(src, 'tags');
    expect(out).not.toContain('tags');
    expect(out).not.toContain('- x');
    expect(out).toContain('title: 甲');
    expect(out).toContain('author: 乙');
    expect(out).toContain('正文');
  });

  it('删除不存在的键 / 无 frontmatter 时，文档原样返回', () => {
    expect(removeProperty(DOC, 'nope')).toBe(DOC);
    const plain = '# 正文\n';
    expect(removeProperty(plain, 'title')).toBe(plain);
  });

});

describe('B3 · 值的格式化（只有必要时才加引号）', () => {
  it('普通文本不加引号，歧义文本才加', () => {
    expect(formatPropertyValue('text', '板的弯曲理论')).toBe('板的弯曲理论');
    expect(formatPropertyValue('text', '- 以连字符开头')).toBe('"- 以连字符开头"');
    expect(formatPropertyValue('text', '含: 冒号空格')).toBe('"含: 冒号空格"');
    expect(formatPropertyValue('text', '# 井号开头')).toBe('"# 井号开头"');
  });

  it('标签与列表规范成行内数组，中英文逗号都支持', () => {
    expect(formatPropertyValue('tags', '力学, 板壳')).toBe('[力学, 板壳]');
    expect(formatPropertyValue('list', '甲，乙')).toBe('[甲, 乙]');
    expect(formatPropertyValue('tags', '  ')).toBe('[]');
  });

  it('布尔与数字规范化', () => {
    expect(formatPropertyValue('checkbox', '是')).toBe('true');
    expect(formatPropertyValue('checkbox', 'false')).toBe('false');
    expect(formatPropertyValue('number', '2.5')).toBe('2.5');
  });
});
