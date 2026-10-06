import { describe, it, expect } from 'vitest';
import { cssRectToNorm, normRectToPdf, normPointToPdf, normalizeRotation } from '../coords';

describe('cssRectToNorm', () => {
  it('maps a full-page rect to 0,0,1,1', () => {
    expect(cssRectToNorm({ left: 0, top: 0, width: 200, height: 100 }, 200, 100))
      .toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('maps a quarter box', () => {
    expect(cssRectToNorm({ left: 100, top: 50, width: 100, height: 50 }, 200, 100))
      .toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('throws when the page has no size', () => {
    expect(() => cssRectToNorm({ left: 0, top: 0, width: 1, height: 1 }, 0, 100)).toThrow();
    expect(() => cssRectToNorm({ left: 0, top: 0, width: 1, height: 1 }, 100, -5)).toThrow();
  });
});

describe('normRectToPdf', () => {
  it('flips y for an 800x600 page, no rotation', () => {
    expect(normRectToPdf({ x: 0, y: 0, w: 0.5, h: 0.5 }, 800, 600, 0))
      .toEqual({ x: 0, y: 300, w: 400, h: 300 });
  });

  it('swaps w/h under a 90 degree rotation', () => {
    const r = normRectToPdf({ x: 0, y: 0, w: 0.5, h: 0.5 }, 800, 600, 90);
    expect(r.w).toBe(300);
    expect(r.h).toBe(400);
  });

  it('is consistent for identity rotation', () => {
    const r = normRectToPdf({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 400, 400, 0);
    expect(r).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });
});

describe('normPointToPdf', () => {
  it('flips the y axis', () => {
    expect(normPointToPdf({ x: 0.5, y: 0.25 }, 800, 600)).toEqual({ x: 400, y: 450 });
  });
});

describe('normalizeRotation', () => {
  it('accepts canonical values and coerces the rest', () => {
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(45)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(0)).toBe(0);
  });
});