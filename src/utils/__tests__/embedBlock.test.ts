import { describe, expect, it } from 'vitest';
import { extractBlock, extractSection } from '../embedBlock';

describe('extractBlock', () => {
  it('切回段落块，并去掉标记与首尾空行', () => {
    const doc = '第一段\n\n第二段到此结束 ^p2\n\n第三段';
    expect(extractBlock(doc, 'p2')).toBe('第二段到此结束');
  });

  it('切回列表项块，包含它的续行', () => {
    const doc = '- 第一项\n  续行仍属于该项 ^li\n\n- 第二项';
    expect(extractBlock(doc, 'li')).toBe('- 第一项\n  续行仍属于该项');
  });

  it('切回表格块，整张表都算一个块', () => {
    const doc = '| 列A | 列B |\n| --- | --- |\n| 1 | 2 | ^tbl\n\n尾段';
    expect(extractBlock(doc, 'tbl')).toBe('| 列A | 列B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('切回引用块', () => {
    expect(extractBlock('> 引用内容 ^q\n\n尾段', 'q')).toBe('> 引用内容');
  });

  it('标题行本身也可以是一个块', () => {
    expect(extractBlock('## 小节标题 ^h\n\n正文', 'h')).toBe('## 小节标题');
  });

  it('围栏代码里的 ^id 是示例，不是锚点', () => {
    const doc = '```\nconst x = 1; // ^fake\n```\n\n真正的段落 ^real';
    expect(extractBlock(doc, 'fake')).toBeNull();
    expect(extractBlock(doc, 'real')).toBe('真正的段落');
  });

  it('容忍标记后的多余空行（空格与制表符）', () => {
    expect(extractBlock('段落 ^pad \t \n\n尾', 'pad')).toBe('段落');
  });

  it('CRLF 文档同样能切出块，且结果统一为 LF', () => {
    const doc = '第一段\r\n\r\n第二段 ^b\r\n\r\n尾';
    expect(extractBlock(doc, 'b')).toBe('第二段');
  });

  it('块 id 大小写不敏感（与 scanBlockIds 的去重口径一致）', () => {
    const doc = '段落 ^Blk1\n\n尾';
    expect(extractBlock(doc, 'blk1')).toBe('段落');
    expect(extractBlock(doc, 'BLK1')).toBe('段落');
  });

  it('标记独占一行时，前后相邻行算进同一个块', () => {
    expect(extractBlock('内容上一行\n^solo\n\n尾', 'solo')).toBe('内容上一行');
  });

  it('标记夹在行中（不在行尾）时不算块', () => {
    expect(extractBlock('段 ^inline 后面还有字\n\n尾', 'inline')).toBeNull();
  });

  it('id 不存在返回 null', () => {
    expect(extractBlock('只有一段 ^exists\n\n尾', 'missing')).toBeNull();
  });

  it('id 非法返回 null（空串、带空格、带符号）', () => {
    const doc = '段落 ^ok\n\n尾';
    expect(extractBlock(doc, '')).toBeNull();
    expect(extractBlock(doc, '   ')).toBeNull();
    expect(extractBlock(doc, 'has space')).toBeNull();
    expect(extractBlock(doc, '^ok')).toBeNull();
    expect(extractBlock(doc, 'bad!id')).toBeNull();
  });
});

describe('extractSection', () => {
  const doc =
    '# 第一章\n\n第一章正文\n\n## 目标\n\n目标正文\n\n### 子节\n\n子节正文\n\n## 下一个\n\n下一个正文';

  it('只取该章节，不含标题行本身', () => {
    expect(extractSection(doc, '目标')).toBe('目标正文\n\n### 子节\n\n子节正文');
  });

  it('遇到同级标题即结束章节', () => {
    expect(extractSection(doc, '下一个')).toBe('下一个正文');
  });

  it('更深层的标题属于本章节，一并带上', () => {
    expect(extractSection(doc, '子节')).toBe('子节正文');
  });

  it('同名标题取第一个', () => {
    const repeated = '## 重复\n\n第一处\n\n## 重复\n\n第二处';
    expect(extractSection(repeated, '重复')).toBe('第一处');
  });

  it('章节一直到文末（后面没有更高层标题）', () => {
    expect(extractSection('# 唯一\n\n到文末为止\n', '唯一')).toBe('到文末为止');
  });

  it('标题匹配忽略首尾空白与大小写，且不要求 # 数量相同', () => {
    expect(extractSection('# Hello World\n\n正文', '  hello WORLD ')).toBe('正文');
    expect(extractSection('## 中文标题\n\n正文', '中文标题')).toBe('正文');
  });

  it('章节末尾的连续空行被裁掉', () => {
    const spaced = '# 一\n\n正文\n\n\n# 二\n\n二正文';
    expect(extractSection(spaced, '一')).toBe('正文');
  });

  it('围栏代码里的 # 不算标题', () => {
    const fenced = '```\n# 假的\n```\n\n# 真的\n\n正文';
    expect(extractSection(fenced, '假的')).toBeNull();
    expect(extractSection(fenced, '真的')).toBe('正文');
  });

  it('标题里的行内代码取自原文，仍能匹配', () => {
    const withCode = '# 关于 `foo` 的说明\n\n正文';
    expect(extractSection(withCode, '关于 `foo` 的说明')).toBe('正文');
  });

  it('找不到标题或标题为空时返回 null', () => {
    expect(extractSection(doc, '不存在的标题')).toBeNull();
    expect(extractSection(doc, '')).toBeNull();
    expect(extractSection(doc, '   ')).toBeNull();
  });
});
