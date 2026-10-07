import { describe, it, expect } from 'vitest';
import { annotAtPoint, createAnnot } from '../annotations';

const size = { width: 600, height: 800 };

describe('annotAtPoint', () => {
  it('hits a highlight rect (normalized -> px)', () => {
    const a = createAnnot({ page: 0, kind: 'highlight', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] });
    // rect spans x 60..240, y 80..120
    expect(annotAtPoint([a], 0, 100, 100, size)?.id).toBe(a.id);
    expect(annotAtPoint([a], 0, 500, 700, size)).toBeNull();
  });

  it('ignores annotations on other pages', () => {
    const a = createAnnot({ page: 1, kind: 'highlight', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] });
    expect(annotAtPoint([a], 0, 100, 100, size)).toBeNull();
  });

  it('picks the smallest when overlapping (innermost wins)', () => {
    const big = createAnnot({ page: 0, kind: 'highlight', rects: [{ x: 0, y: 0, w: 0.9, h: 0.9 }] });
    const small = createAnnot({ page: 0, kind: 'highlight', rects: [{ x: 0.4, y: 0.4, w: 0.05, h: 0.02 }] });
    expect(annotAtPoint([big, small], 0, 0.42 * 600, 0.41 * 800, size)?.id).toBe(small.id);
  });

  it('hits ink strokes via their bounding box', () => {
    const a = createAnnot({ page: 0, kind: 'ink', points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }] });
    expect(annotAtPoint([a], 0, 0.55 * 600, 0.55 * 800, size)?.id).toBe(a.id);
  });

  it('has a few px of slack so thin lines are easy to hit', () => {
    const a = createAnnot({ page: 0, kind: 'underline', rects: [{ x: 0.2, y: 0.5, w: 0.3, h: 0.002 }] });
    // 1px below the 1.6px-tall rect: within the 3px slack
    expect(annotAtPoint([a], 0, 0.3 * 600, 0.5 * 800 + 3, size)?.id).toBe(a.id);
  });

  it('returns null for an empty annotation list', () => {
    expect(annotAtPoint([], 0, 10, 10, size)).toBeNull();
  });
});