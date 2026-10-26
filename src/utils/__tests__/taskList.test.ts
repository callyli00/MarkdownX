import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdownRenderer';

/**
 * A layer: 任务列表的写回钩子。
 *
 * 宿主需要知道「这一行待办在源码的哪个位置」才能把勾选/取消勾选写回文件。渲染器因此在
 * <li> 和它自己的 <input> 上各挂一份 data-task-line / data-task-offset，同一个条目两处数值
 * 必须相同（是同一份坐标，不是两次各自估算）。
 *
 * 坐标空间：行号 1 起算；偏移是条目起始 '-' 在原文档里的字符偏移。两者都建立在
 * LF 归一化后的原文上 —— 这与既有的 data-src-* 锚点完全同一坐标系（processMathAndCitations
 * 一进来就把 \r\n 归一成 \n），所以 CRLF 文件写回前需要先做同样的归一化。
 */
interface TaskCoord {
  line: number;
  offset: number;
}

/** 按渲染顺序取出每个任务条目的坐标（只读 <li> 上那一份）。 */
const taskCoords = (html: string): TaskCoord[] => {
  const out: TaskCoord[] = [];
  const re = /<li class="task-list-item" data-task-line="(\d+)" data-task-offset="(\d+)">/g;
  let match: RegExpExecArray | null = re.exec(html);
  while (match !== null) {
    out.push({ line: Number(match[1]), offset: Number(match[2]) });
    match = re.exec(html);
  }
  return out;
};

const checkboxCount = (html: string) => (html.match(/type="checkbox"/g) || []).length;

describe('A 层 · 任务列表写回钩子', () => {
  it('<li> 与 <input> 都带同一份 data-task-* 坐标', async () => {
    const html = await renderMarkdown('- [ ] 待办一\n- [x] 已完成\n', '');
    // 视觉与既有输出一致：复选框与文字都还在（只有属性是新增的）
    expect(checkboxCount(html)).toBe(2);
    expect(html).toContain('待办一');
    expect(html).toContain('已完成');
    expect((html.match(/<li class="task-list-item"/g) || []).length).toBe(2);
    // 每个条目两处（li + input）
    expect((html.match(/data-task-line="\d+"/g) || []).length).toBe(4);
    expect((html.match(/data-task-offset="\d+"/g) || []).length).toBe(4);
    // 占位符绝不能漏进 DOM
    expect(html).not.toContain('@@TASK');
  });

  it('行号 1 起算、偏移是条目起始字符的原文档偏移', async () => {
    const md = '# 标题\n\n- [ ] 第一项\n- [x] 第二项\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([
      { line: 3, offset: md.indexOf('- [ ] 第一项') },
      { line: 4, offset: md.indexOf('- [x] 第二项') }
    ]);
  });

  it('<input> 上的坐标与所在 <li> 相同', async () => {
    const html = await renderMarkdown('- [ ] 唯一条目\n', '');
    expect(html).toContain('<li class="task-list-item" data-task-line="1" data-task-offset="0">');
    expect(html).toContain('type="checkbox" data-task-line="1" data-task-offset="0">');
  });

  it('前面的公式被改写后偏移仍然精确（坐标走源码翻译表）', async () => {
    const md = '公式 $a=b$ 之后\n\n- [ ] 待办\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([{ line: 3, offset: md.indexOf('- [ ] 待办') }]);
  });

  it('围栏代码块之前的任务列表：掩码是等长的，不影响坐标', async () => {
    const md = '```js\nconst x = 1;\n```\n\n- [ ] 待办\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([{ line: 5, offset: md.indexOf('- [ ] 待办') }]);
  });

  it('嵌套任务列表：父子条目各自一份坐标', async () => {
    const md = '- [ ] 父项\n  - [x] 子项\n- [ ] 第三项\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([
      { line: 1, offset: md.indexOf('- [ ] 父项') },
      { line: 2, offset: md.indexOf('- [x] 子项') },
      { line: 3, offset: md.indexOf('- [ ] 第三项') }
    ]);
  });

  it('引用块里的任务列表也带坐标（偏移含 > 前缀）', async () => {
    const md = '> - [ ] 引用里的待办\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([{ line: 1, offset: md.indexOf('- [ ] 引用里的待办') }]);
  });

  it('同一文档里多个任务列表互不串号', async () => {
    const md = '- [ ] 甲\n\n中间段落\n\n- [x] 乙\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([
      { line: 1, offset: md.indexOf('- [ ] 甲') },
      { line: 5, offset: md.indexOf('- [x] 乙') }
    ]);
  });

  it('普通列表项与围栏里的 - [ ] 不受影响', async () => {
    const plain = await renderMarkdown('- 普通一\n- 普通二\n', '');
    expect(plain).toContain('<li>普通一</li>');
    expect(plain).not.toContain('data-task-line');
    const fenced = await renderMarkdown('```\n- [ ] not a task\n```\n', '');
    expect(fenced).not.toContain('data-task-line');
    expect(fenced).toContain('- [ ] not a task');
  });

  it('同一个列表里普通条目保持默认输出', async () => {
    const html = await renderMarkdown('- [ ] 待办\n- 普通条目\n', '');
    expect((html.match(/<li class="task-list-item"/g) || []).length).toBe(1);
    expect(html).toContain('<li>普通条目</li>');
    expect(taskCoords(html)).toEqual([{ line: 1, offset: 0 }]);
  });

  it('CRLF 文档：坐标落在 LF 归一化空间（与 data-src-* 同一坐标系）', async () => {
    const md = '- [ ] a\r\n- [x] b\r\n';
    const html = await renderMarkdown(md, '');
    expect(taskCoords(html)).toEqual([
      { line: 1, offset: 0 },
      { line: 2, offset: 8 }
    ]);
  });
});
