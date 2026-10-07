import React, { useRef, useState, useCallback } from 'react';
import {
  createAnnot,
  annotsForPage,
  type PdfAnnot,
  type ViewerTool,
  type NormRect,
} from './annotations';
import { cssRectToNorm } from './coords';

interface PdfAnnotLayerProps {
  pageIndex: number;
  annots: PdfAnnot[];
  /** Rendered page size in CSS pixels (must match the canvas it overlays). */
  width: number;
  height: number;
  /**
   * Active tool:
   *  - null            -> passive; the layer stays transparent to pointer events so
   *                       the PDF.js text layer keeps native selection behaviour.
   *  - 'delete'        -> drag a box; every annotation inside it is removed.
   *  - 'note' | 'ink'  -> drag to draw that mark.
   *  - highlight/underline/strikeout -> drawn from a TEXT SELECTION, so the layer
   *    stays passive here too (handled by the viewer, not by this component).
   */
  tool: ViewerTool | null;
  onAdd: (a: PdfAnnot) => void;
  /** Ids collected by a box-delete gesture. */
  onDeleteMany?: (ids: string[]) => void;
}

/** Axis-aligned bounding box of an annotation, in normalized page space. */
function annotBBox(a: PdfAnnot): NormRect | null {
  if (a.kind === 'ink') {
    if (!a.points.length) return null;
    const xs = a.points.map((p) => p.x);
    const ys = a.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  if (!a.rects.length) return null;
  const minX = Math.min(...a.rects.map((r) => r.x));
  const minY = Math.min(...a.rects.map((r) => r.y));
  const maxX = Math.max(...a.rects.map((r) => r.x + r.w));
  const maxY = Math.max(...a.rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function intersects(a: NormRect, b: NormRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Sits exactly on top of a page's canvas. It draws existing annotations and, for
 * the drag-based tools (delete / note / ink), converts pointer gestures into
 * actions. It never intercepts events for text-selection tools.
 */
export const PdfAnnotLayer: React.FC<PdfAnnotLayerProps> = ({
  pageIndex,
  annots,
  width,
  height,
  tool,
  onAdd,
  onDeleteMany,
}) => {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [ink, setInk] = useState<{ x: number; y: number }[]>([]);

  // Only these tools are drawn by dragging on this layer.
  const drawing = tool === 'note' || tool === 'ink';
  const deleting = tool === 'delete';
  const interactive = drawing || deleting;

  const local = useCallback((e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }, []);

  const boxFromDrag = (d: { x0: number; y0: number; x1: number; y1: number }) =>
    cssRectToNorm(
      {
        left: Math.min(d.x0, d.x1),
        top: Math.min(d.y0, d.y1),
        width: Math.abs(d.x1 - d.x0),
        height: Math.abs(d.y1 - d.y0),
      },
      width,
      height
    );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || width <= 0 || height <= 0) return;
    // Guarded: setPointerCapture throws NotFoundError for an unknown pointer id,
    // and a throw here would abort the whole gesture.
    try {
      ref.current?.setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimisation; dragging still works without it */
    }
    const p = local(e);
    if (tool === 'ink') setInk([p]);
    else setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!interactive) return;
    const p = local(e);
    if (tool === 'ink' && ink.length) setInk((prev) => [...prev, p]);
    else if (drag) setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
  };

  const onPointerUp = () => {
    if (!interactive) return;

    if (tool === 'ink' && ink.length > 1) {
      onAdd(
        createAnnot({
          page: pageIndex,
          kind: 'ink',
          points: ink.map((p) => ({ x: p.x / width, y: p.y / height })),
        })
      );
    } else if (drag) {
      const rect = boxFromDrag(drag);
      if (rect.w > 0.002 && rect.h > 0.002) {
        if (deleting) {
          const doomed = annotsForPage(annots, pageIndex)
            .filter((a) => {
              const bb = annotBBox(a);
              return bb ? intersects(bb, rect) : false;
            })
            .map((a) => a.id);
          if (doomed.length) onDeleteMany?.(doomed);
        } else {
          onAdd(createAnnot({ page: pageIndex, kind: tool as PdfAnnot['kind'], rects: [rect] }));
        }
      }
    }
    setDrag(null);
    setInk([]);
  };

  const pageAnnots = annotsForPage(annots, pageIndex);

  return (
    <svg
      ref={ref}
      className="pdf-annot-layer"
      width={width}
      height={height}
      style={{ pointerEvents: interactive ? 'auto' : 'none', cursor: interactive ? 'crosshair' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {pageAnnots.map((a) => (
        <g key={a.id} style={{ pointerEvents: 'none' }}>
          {a.kind === 'ink' && (
            <polyline
              points={a.points.map((p) => `${p.x * width},${p.y * height}`).join(' ')}
              fill="none"
              stroke={a.color}
              strokeWidth={2}
              opacity={a.opacity}
            />
          )}
          {a.kind === 'note' && a.rects.map((r, i) => (
            <g key={i}>
              <rect
                x={r.x * width}
                y={r.y * height}
                width={r.w * width}
                height={r.h * height}
                fill={a.color}
                fillOpacity={0.15}
                stroke={a.color}
                strokeWidth={1}
              />
              <text x={r.x * width + 4} y={r.y * height + 12} fontSize={10} fill={a.color}>
                {a.text.slice(0, 24)}
              </text>
            </g>
          ))}
          {a.kind === 'highlight' && a.rects.map((r, i) => (
            <rect
              key={i}
              x={r.x * width}
              y={r.y * height}
              width={r.w * width}
              height={r.h * height}
              fill={a.color}
              opacity={a.opacity}
            />
          ))}
          {a.kind === 'underline' && a.rects.map((r, i) => (
            <line
              key={i}
              x1={r.x * width}
              y1={(r.y + r.h) * height}
              x2={(r.x + r.w) * width}
              y2={(r.y + r.h) * height}
              stroke={a.color}
              strokeWidth={1.5}
              opacity={a.opacity}
            />
          ))}
          {a.kind === 'strikeout' && a.rects.map((r, i) => (
            <line
              key={i}
              x1={r.x * width}
              y1={(r.y + r.h / 2) * height}
              x2={(r.x + r.w) * width}
              y2={(r.y + r.h / 2) * height}
              stroke={a.color}
              strokeWidth={1.5}
              opacity={a.opacity}
            />
          ))}
        </g>
      ))}

      {drag && (
        <rect
          x={Math.min(drag.x0, drag.x1)}
          y={Math.min(drag.y0, drag.y1)}
          width={Math.abs(drag.x1 - drag.x0)}
          height={Math.abs(drag.y1 - drag.y0)}
          fill={deleting ? 'rgba(239, 68, 68, 0.18)' : tool === 'highlight' ? '#ffd400' : 'none'}
          opacity={deleting ? 1 : 0.35}
          stroke={deleting ? '#ef4444' : '#e11d48'}
          strokeDasharray="4 2"
        />
      )}
      {ink.length > 1 && (
        <polyline
          points={ink.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="#e11d48"
          strokeWidth={2}
        />
      )}
    </svg>
  );
};