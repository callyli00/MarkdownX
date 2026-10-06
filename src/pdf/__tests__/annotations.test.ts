import { describe, it, expect } from 'vitest';
import { createAnnot, hexToRgb, annotsForPage, defaultOpacity } from '../annotations';

describe('createAnnot', () => {
  it('fills sensible defaults', () => {
    const a = createAnnot({ page: 0, kind: 'highlight' });
    expect(a.color).toBe('#ffd400');
    expect(a.opacity).toBe(0.35);
    expect(a.rects).toEqual([]);
    expect(a.points).toEqual([]);
    expect(a.id.startsWith('annot-')).toBe(true);
  });

  it('honours explicit overrides', () => {
    const a = createAnnot({ page: 2, kind: 'note', text: 'hi', color: '#123456', opacity: 0.5 });
    expect(a.text).toBe('hi');
    expect(a.color).toBe('#123456');
    expect(a.opacity).toBe(0.5);
    expect(a.page).toBe(2);
    expect(a.kind).toBe('note');
  });
});

describe('hexToRgb', () => {
  it('converts #ff0000 to pure red', () => {
    const { r, g, b } = hexToRgb('#ff0000');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });

  it('accepts a missing leading hash', () => {
    expect(hexToRgb('00ff00').g).toBeCloseTo(1);
  });

  it('rejects malformed input', () => {
    expect(() => hexToRgb('red')).toThrow();
    expect(() => hexToRgb('#12345')).toThrow();
  });
});

describe('annotsForPage', () => {
  it('filters by page index', () => {
    const list = [createAnnot({ page: 0, kind: 'ink' }), createAnnot({ page: 1, kind: 'ink' })];
    expect(annotsForPage(list, 1)).toHaveLength(1);
    expect(annotsForPage(list, 0)).toHaveLength(1);
    expect(annotsForPage(list, 9)).toHaveLength(0);
  });
});

describe('defaultOpacity', () => {
  it('is translucent for highlight, near-opaque otherwise', () => {
    expect(defaultOpacity('highlight')).toBe(0.35);
    expect(defaultOpacity('ink')).toBe(0.9);
  });
});