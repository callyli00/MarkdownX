import { describe, expect, it } from 'vitest';
import { isFullReplace, isNoopPatch, planPatch } from '../domPatch';

describe('planPatch', () => {
  it('内容完全没变时是无操作', () => {
    const plan = planPatch(['<p>a</p>', '<p>b</p>'], ['<p>a</p>', '<p>b</p>']);
    expect(plan).toEqual({ prefix: 2, suffix: 0, removeCount: 0, insert: [] });
    expect(isNoopPatch(plan)).toBe(true);
  });

  it('只改中间一块时，前后都保留', () => {
    const plan = planPatch(['<p>a</p>', '<p>b</p>', '<p>c</p>'], ['<p>a</p>', '<p>B</p>', '<p>c</p>']);
    expect(plan).toEqual({ prefix: 1, suffix: 1, removeCount: 1, insert: ['<p>B</p>'] });
    expect(isNoopPatch(plan)).toBe(false);
  });

  it('只改最后一块时只在尾部替换', () => {
    const plan = planPatch(['<p>a</p>', '<p>b</p>'], ['<p>a</p>', '<p>bb</p>']);
    expect(plan).toEqual({ prefix: 1, suffix: 0, removeCount: 1, insert: ['<p>bb</p>'] });
  });

  it('尾部追加时没有删除', () => {
    const plan = planPatch(['<p>a</p>'], ['<p>a</p>', '<p>b</p>']);
    expect(plan).toEqual({ prefix: 1, suffix: 0, removeCount: 0, insert: ['<p>b</p>'] });
  });

  it('尾部删除时没有插入', () => {
    const plan = planPatch(['<p>a</p>', '<p>b</p>'], ['<p>a</p>']);
    expect(plan).toEqual({ prefix: 1, suffix: 0, removeCount: 1, insert: [] });
  });

  it('首尾都不相同 → 整篇替换', () => {
    const plan = planPatch(['<p>a</p>', '<p>b</p>'], ['<h1>c</h1>', '<p>d</p>']);
    expect(plan).toEqual({ prefix: 0, suffix: 0, removeCount: 2, insert: ['<h1>c</h1>', '<p>d</p>'] });
    expect(isFullReplace(plan, 2)).toBe(true);
  });

  it('首尾重叠时不会重复计数（同样的段落重复出现）', () => {
    const plan = planPatch(['<p>x</p>', '<p>x</p>'], ['<p>x</p>']);
    expect(plan.prefix + plan.suffix).toBeLessThanOrEqual(Math.min(2, 1) + 1);
    expect(plan.removeCount).toBeGreaterThanOrEqual(0);
    expect(plan.prefix + plan.removeCount + plan.suffix).toBe(2);
    expect(plan.prefix + plan.insert.length + plan.suffix).toBe(1);
  });

  it('空文档到有内容', () => {
    const plan = planPatch([], ['<p>a</p>']);
    expect(plan).toEqual({ prefix: 0, suffix: 0, removeCount: 0, insert: ['<p>a</p>'] });
  });

  it('有内容到空文档', () => {
    const plan = planPatch(['<p>a</p>'], []);
    expect(plan).toEqual({ prefix: 0, suffix: 0, removeCount: 1, insert: [] });
  });

  it('两边都空是无操作', () => {
    const plan = planPatch([], []);
    expect(isNoopPatch(plan)).toBe(true);
  });

  it('新增公式块只替换该块（其它块不必重新排版）', () => {
    const prev = ['<h1>标题</h1>', '<p>第一段</p>', '<p>第三段</p>'];
    const next = ['<h1>标题</h1>', '<p>第一段</p>', '<p>带公式</p>', '<p>第三段</p>'];
    const plan = planPatch(prev, next);
    expect(plan.prefix).toBe(2);
    expect(plan.suffix).toBe(1);
    expect(plan.insert).toEqual(['<p>带公式</p>']);
  });
});
