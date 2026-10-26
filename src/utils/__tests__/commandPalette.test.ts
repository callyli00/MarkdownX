import { describe, expect, it } from 'vitest';
import { rankCommands, scoreCommand, type PaletteCommand } from '../commandPalette';

const commands: PaletteCommand[] = [
  { id: 'file.save', title: '保存当前文档', keywords: ['save'], shortcut: 'Ctrl+S' },
  { id: 'file.saveAs', title: '另存为 PDF 文档', keywords: ['pdf', '另存'] },
  { id: 'export.html', title: '导出 HTML（带样式）', keywords: ['html', '导出'] },
  { id: 'export.latex', title: '导出 LaTeX', keywords: ['tex'] },
  { id: 'view.source', title: '切换源码模式', keywords: ['mode'] },
  { id: 'theme.cycle', title: '切换主题', keywords: ['theme', 'dark'] },
  { id: 'edit.rename', title: '重命名当前笔记', keywords: ['rename'] },
  { id: 'help.devtools', title: '开发者工具' }
];

describe('scoreCommand', () => {
  it('空查询得分大于 0（表示"可以列出"）', () => {
    expect(scoreCommand(commands[0], ' ')).toBeGreaterThan(0);
  });

  it('标题前缀命中', () => {
    expect(scoreCommand(commands[0], '保存')).toBeGreaterThan(0);
  });

  it('关键词命中', () => {
    expect(scoreCommand(commands[0], 'save')).toBeGreaterThan(0);
  });

  it('完全不相关的查询得 0', () => {
    expect(scoreCommand(commands[0], 'zzzz')).toBe(0);
  });

  it('多词必须同时命中（AND 语义）', () => {
    const exportHtml = commands[2];
    expect(scoreCommand(exportHtml, '导出 html')).toBeGreaterThan(0);
    expect(scoreCommand(exportHtml, '导出 latex')).toBe(0);
  });

  it('大小写不敏感', () => {
    expect(scoreCommand(commands[2], 'HTML')).toBeGreaterThan(0);
  });

  it('拉丁首字母缩写能匹配', () => {
    expect(scoreCommand(commands[4], 'ssom')).toBe(0); // 太任意，不该命中
    expect(scoreCommand({ id: 'view.source', title: 'Source View' }, 'sv')).toBeGreaterThan(0);
  });

  it('前缀命中分数高于文中间命中', () => {
    const prefix = { id: 'a', title: '导出 HTML' };
    const middle = { id: 'b', title: '批量导出 HTML 为图片' };
    expect(scoreCommand(prefix, '导出')).toBeGreaterThan(scoreCommand(middle, '导出'));
  });
});

describe('rankCommands', () => {
  it('空查询按声明顺序取前 N 条', () => {
    expect(rankCommands(commands, '', 3).map((c) => c.id)).toEqual(['file.save', 'file.saveAs', 'export.html']);
  });

  it('前缀更贴近的排在前面（两条导出命令占据前两位）', () => {
    const ranked = rankCommands(commands, '导出', 10).map((c) => c.id);
    expect(ranked.slice(0, 2).sort()).toEqual(['export.html', 'export.latex']);
  });

  it('关键词也能把命令捞出来', () => {
    expect(rankCommands(commands, 'pdf', 5).map((c) => c.id)).toContain('file.saveAs');
  });

  it('没有匹配时返回空数组（面板显示"没有匹配"）', () => {
    expect(rankCommands(commands, 'qqqqqq', 10)).toEqual([]);
  });

  it('limit 生效', () => {
    expect(rankCommands(commands, '', 2)).toHaveLength(2);
  });

  it('同分时保持声明顺序（排序稳定）', () => {
    const same: PaletteCommand[] = [
      { id: 'a', title: '导出 一' },
      { id: 'b', title: '导出 二' }
    ];
    expect(rankCommands(same, '导出', 5).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('标题更短的优先（同分情况下更精确）', () => {
    const shortLong: PaletteCommand[] = [
      { id: 'long', title: '保存当前文档到磁盘' },
      { id: 'short', title: '保存' }
    ];
    expect(rankCommands(shortLong, '保存', 5)[0].id).toBe('short');
  });

  it('查询两端的空白被忽略', () => {
    expect(rankCommands(commands, '  主题  ', 5)[0].id).toBe('theme.cycle');
  });
});
