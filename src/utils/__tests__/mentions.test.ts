import { describe, expect, it } from 'vitest';
import { findUnlinkedMentions, mentionTerms } from '../mentions';

const target = { path: 'C:/vault/alpha.md', name: 'alpha.md' };

const doc = (path: string, content: string) => ({ path: `C:/vault/${path}`, content });

describe('mentionTerms', () => {
  it('去重并同时接受带/不带扩展名的名字', () => {
    expect(mentionTerms({ path: 'C:/v/note.md', name: 'note.md' })).toEqual(['note.md', 'note']);
  });

  it('并入别名，大小写不同的重复项只留一个，单字别名丢弃', () => {
    expect(mentionTerms({ path: 'C:/v/note.md', name: 'note.md', aliases: ['Alpha', 'alpha', '甲'] })).toEqual([
      'note.md',
      'note',
      'Alpha'
    ]);
  });

  it('单字名被丢弃（匹配"a"等于标记半个仓库）', () => {
    expect(mentionTerms({ path: 'C:/v/a.md', name: 'a.md' })).toEqual([]);
    expect(mentionTerms({ path: 'C:/v/a.md', name: 'a.md', aliases: ['甲乙'] })).toEqual([]);
  });
});

describe('findUnlinkedMentions', () => {
  it('找到正文里的普通提及并给出行号与片段', () => {
    const hits = findUnlinkedMentions([doc('beta.md', '第一行\nalpha 那篇写了公式\n')], target);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].snippet).toBe('alpha 那篇写了公式');
    expect(hits[0].term).toBe('alpha');
  });

  it('已经写成 [[链接]] 的地方不算未链接提及', () => {
    const hits = findUnlinkedMentions([doc('beta.md', '见 [[alpha]] 与 [[alpha|别名]]\n')], target);
    expect(hits).toEqual([]);
  });

  it('链接与普通提及混在一行时，只保留未被链接包住的那次', () => {
    const hits = findUnlinkedMentions([doc('beta.md', '[[alpha]] 和 alpha 都提到了\n')], target);
    expect(hits).toHaveLength(1);
  });

  it('围栏代码里的名字不算（那是示例，不是正文）', () => {
    const hits = findUnlinkedMentions([doc('beta.md', '```\nalpha\n```\n正文没提\n')], target);
    expect(hits).toEqual([]);
  });

  it('行内代码里的名字不算', () => {
    const hits = findUnlinkedMentions([doc('beta.md', '写作 `alpha` 时要注意\n')], target);
    expect(hits).toEqual([]);
  });

  it('不匹配更长的拉丁词（alphabet 不是 alpha）', () => {
    const hits = findUnlinkedMentions([doc('beta.md', 'alphabet soup\n')], target);
    expect(hits).toEqual([]);
  });

  it('中文紧贴也不算更长的词（甲alpha乙 里能匹配到 alpha）', () => {
    const hits = findUnlinkedMentions([doc('beta.md', '甲alpha乙\n')], target);
    expect(hits).toHaveLength(1);
  });

  it('大小写不敏感', () => {
    const hits = findUnlinkedMentions([doc('beta.md', 'ALPHA 是最先写的\n')], target);
    expect(hits).toHaveLength(1);
  });

  it('别名命中时 term 报告别名本身', () => {
    const withAliases = { path: 'C:/vault/alpha.md', name: 'alpha.md', aliases: ['首篇'] };
    const hits = findUnlinkedMentions([doc('beta.md', '首篇讲的是公式编号\n')], withAliases);
    expect(hits).toHaveLength(1);
    expect(hits[0].term).toBe('首篇');
  });

  it('同一文件同一行只出一行（多个名字命中不重复）', () => {
    const withAliases = { path: 'C:/vault/alpha.md', name: 'alpha.md', aliases: ['首篇'] };
    const hits = findUnlinkedMentions([doc('beta.md', 'alpha 就是首篇\n')], withAliases);
    expect(hits).toHaveLength(1);
  });

  it('每个文件最多 limitPerDoc 行', () => {
    const hits = findUnlinkedMentions([doc('beta.md', 'alpha\nalpha\nalpha\nalpha\n')], target, { limitPerDoc: 2 });
    expect(hits).toHaveLength(2);
  });

  it('跳过被描述的那篇笔记自己', () => {
    const hits = findUnlinkedMentions([doc('alpha.md', 'alpha 自己提自己\n')], target);
    expect(hits).toEqual([]);
  });

  it('多个文件按路径、行号排序', () => {
    const hits = findUnlinkedMentions(
      [doc('gamma.md', 'alpha\n'), doc('beta.md', 'alpha\n')],
      target
    );
    expect(hits.map((h) => h.docPath)).toEqual(['C:/vault/beta.md', 'C:/vault/gamma.md']);
  });

  it('超长片段被截断到一个视觉行', () => {
    const long = `${'前'.repeat(300)}alpha`;
    const hits = findUnlinkedMentions([doc('beta.md', long)], target, { snippetMax: 40 });
    expect(hits[0].snippet.length).toBe(40);
    expect(hits[0].snippet.endsWith('…')).toBe(true);
  });

  it('CRLF 文档行号正确', () => {
    const hits = findUnlinkedMentions([doc('beta.md', 'a\r\nb\r\nalpha here\r\n')], target);
    expect(hits[0].line).toBe(3);
  });

  it('空查询词（名字只有 1 个字）直接返回空', () => {
    const hits = findUnlinkedMentions([doc('beta.md', 'a 出现了\n')], { path: 'C:/vault/a.md', name: 'a.md' });
    expect(hits).toEqual([]);
  });
});
