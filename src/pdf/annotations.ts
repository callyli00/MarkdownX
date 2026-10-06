/**
 * Annotation model.
 *
 * Geometry is stored NORMALIZED (0..1, top-left origin) so annotations are
 * independent of render scale, zoom level, device pixel ratio and window size.
 * Absolute PDF points are computed only at flatten time (see flatten.ts).
 */

export interface NormRect { x: number; y: number; w: number; h: number; }
export interface NormPoint { x: number; y: number; }

export type AnnotKind = 'highlight' | 'underline' | 'strikeout' | 'note' | 'ink';

export interface PdfAnnot {
  id: string;
  /** 0-based page index. */
  page: number;
  kind: AnnotKind;
  /** Used by highlight / underline / strikeout (one rect per text line). */
  rects: NormRect[];
  /** Used by ink only. */
  points: NormPoint[];
  /** Note body (or empty string). */
  text: string;
  /** Hex color, e.g. '#ffd400'. */
  color: string;
  /** 0..1. */
  opacity: number;
  createdAt: number;
}

export function defaultColor(kind: AnnotKind): string {
  switch (kind) {
    case 'highlight': return '#ffd400';
    case 'underline':
    case 'strikeout':
    case 'ink': return '#e11d48';
    case 'note': return '#f59e0b';
  }
}

export function defaultOpacity(kind: AnnotKind): number {
  return kind === 'highlight' ? 0.35 : 0.9;
}

export function createAnnot(
  partial: Pick<PdfAnnot, 'page' | 'kind'> & Partial<PdfAnnot>
): PdfAnnot {
  return {
    id: `annot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    page: partial.page,
    kind: partial.kind,
    rects: partial.rects ?? [],
    points: partial.points ?? [],
    text: partial.text ?? '',
    color: partial.color ?? defaultColor(partial.kind),
    opacity: partial.opacity ?? defaultOpacity(partial.kind),
    createdAt: Date.now(),
  };
}

/** Hex '#rrggbb' -> channel values in 0..1 (for pdf-lib's rgb()). Throws on bad input. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function annotsForPage(annots: PdfAnnot[], page: number): PdfAnnot[] {
  return annots.filter((a) => a.page === page);
}