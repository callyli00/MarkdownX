/**
 * Coordinate conversions.
 *
 *  - Overlay space: CSS pixels, top-left origin.
 *  - Stored space:  normalized 0..1, top-left origin.
 *  - PDF space:     points, BOTTOM-left origin (y grows upward).
 *
 * Rotation is applied when the page carries a /Rotate value, because pdf-lib
 * draws in unrotated user space while the user sees the rotated page.
 */

import type { NormRect, NormPoint } from './annotations';

export type PdfRotation = 0 | 90 | 180 | 270;

export interface PdfRect { x: number; y: number; w: number; h: number; }

export function normalizeRotation(deg: number): PdfRotation {
  const n = ((deg % 360) + 360) % 360;
  if (n === 90 || n === 180 || n === 270) return n;
  return 0;
}

/** CSS-pixel rect relative to the page box -> normalized top-left rect. */
export function cssRectToNorm(
  rect: { left: number; top: number; width: number; height: number },
  pageCssWidth: number,
  pageCssHeight: number
): NormRect {
  if (pageCssWidth <= 0 || pageCssHeight <= 0) {
    throw new Error('page size must be positive');
  }
  return {
    x: rect.left / pageCssWidth,
    y: rect.top / pageCssHeight,
    w: rect.width / pageCssWidth,
    h: rect.height / pageCssHeight,
  };
}

/** Normalized top-left rect -> PDF points (bottom-left origin), honouring /Rotate. */
export function normRectToPdf(
  rect: NormRect,
  pageWidthPt: number,
  pageHeightPt: number,
  rotation: PdfRotation = 0
): PdfRect {
  const w = rect.w * pageWidthPt;
  const h = rect.h * pageHeightPt;
  const x = rect.x * pageWidthPt;
  const y = pageHeightPt - rect.y * pageHeightPt - h;

  switch (rotation) {
    case 90:
      return { x: pageHeightPt - y - h, y: x, w: h, h: w };
    case 180:
      return { x: pageWidthPt - x - w, y: pageHeightPt - y - h, w, h };
    case 270:
      return { x: y, y: pageWidthPt - x - w, w: h, h: w };
    default:
      return { x, y, w, h };
  }
}

/** Normalized top-left point -> PDF point (bottom-left origin). Used for ink strokes. */
export function normPointToPdf(
  p: NormPoint,
  pageWidthPt: number,
  pageHeightPt: number
): { x: number; y: number } {
  return { x: p.x * pageWidthPt, y: pageHeightPt - p.y * pageHeightPt };
}