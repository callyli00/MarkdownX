import { describe, it, expect } from 'vitest';
import { classifyLink, resolveRelativePath, anchorCandidates } from '../linkTarget';

describe('链接分类', () => {
  it('锚点链接', () => {
    expect(classifyLink('#heading-x')).toEqual({ kind: 'anchor', fragment: 'heading-x' });
    expect(classifyLink('#10.-%E5%AE%9A%E7%90%86').kind).toBe('anchor');
  });

  it('相对文件链接（含带锚点的形式）', () => {
    expect(classifyLink('./other.md')).toEqual({ kind: 'file', path: './other.md', fragment: '' });
    expect(classifyLink('sub/a.md#sec')).toEqual({ kind: 'file', path: 'sub/a.md', fragment: 'sec' });
    expect(classifyLink('../x/y.PDF')).toEqual({ kind: 'file', path: '../x/y.PDF', fragment: '' });
    expect(classifyLink('C:\\docs\\a.md')).toEqual({ kind: 'file', path: 'C:\\docs\\a.md', fragment: '' });
  });

  it('外部链接与不可解析的协议', () => {
    expect(classifyLink('https://example.com/a.md').kind).toBe('external');
    expect(classifyLink('mailto:a@b.c').kind).toBe('external');
    expect(classifyLink('asset://localhost/x').kind).toBe('other');
    expect(classifyLink('data:text/plain,hi').kind).toBe('other');
  });

  it('既不是文件也不是锚点的保持 other（不猜）', () => {
    expect(classifyLink('some-page').kind).toBe('other');
    expect(classifyLink('').kind).toBe('other');
  });
});

describe('相对路径解析', () => {
  it('与当前文档同目录', () => {
    expect(resolveRelativePath('./b.md', 'C:\\docs\\a.md')).toBe('C:\\docs\\b.md');
    expect(resolveRelativePath('b.md', 'C:/docs/a.md')).toBe('C:/docs/b.md');
  });

  it('向上与进入子目录', () => {
    expect(resolveRelativePath('../b.md', 'C:/docs/sub/a.md')).toBe('C:/docs/b.md');
    expect(resolveRelativePath('./sub/b.md', 'C:/docs/a.md')).toBe('C:/docs/sub/b.md');
    expect(resolveRelativePath('../../b.md', 'C:/a/b/c.md')).toBe('C:/b.md');
  });

  it('反斜杠路径保持反斜杠风格', () => {
    expect(resolveRelativePath('./b.md', 'C:\\docs\\a.md')).toContain('\\');
  });

  it('未保存的文档（空路径）不猜', () => {
    expect(resolveRelativePath('./b.md', '')).toBe('b.md');
  });
});

describe('锚点候选（标题 id 是百分号编码的）', () => {
  it('同时给出原样、解码与再编码三种形式', () => {
    const cands = anchorCandidates('10.-%E5%AE%9A%E7%90%86');
    expect(cands[0]).toBe('10.-%E5%AE%9A%E7%90%86');
    expect(cands[1]).toBe('10.-定理');
    expect(cands).toContain('10.-定理');
  });
  it('普通锚点不会重复', () => {
    expect(anchorCandidates('plain')).toEqual(['plain']);
  });
});
