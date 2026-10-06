import React, { useRef, useState, useCallback } from 'react';
import { createAnnot, annotsForPage, type PdfAnnot, type AnnotKind } from './annotations';
import { cssRectToNorm } from './coords';

interface PdfAnnotLayerProps {
  pageIndex: number;
  annots: PdfAnnot[];
  /** Rendered page size in CSS pixels (must match the canvas it overlays). */
  width: number;
  height: number;
  /** Active drawing tool; null means "select" (annotations are clickable). */
  tool: AnnotKind | null;
  onAdd: (a: PdfAnnot) => void;
  onDelete?: (id: string) => void;
}

/**
 * Interaction layer sitting exactly on top of a page canvas. It converts pointer
 * gestures into normalized-coordinate annotations and draws the existing ones.
 */
export const PdfAnnotLayer: React.FC<PdfAnnotLayerProps> = ({
  pageIndex,
  annots,
  width,
  height,
  tool,
  onAdd,
  onDelete,
}) => {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [ink, setInk] = useState<{ x: number; y: number }[]>([]);

  const local = useCallback((e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!tool || width <= 0 || height <= 0) return;
    ref.current?.setPointerCapture(e.pointerId);
    const p = local(e);
    if (tool === 'ink') setInk([p]);
    else setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!tool) return;
    const p = local(e);
    if (tool === 'ink' && ink.length) setInk((prev) => [...prev, p]);
    else if (drag) setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
  };

  const onPointerUp = () => {
    if (!tool) return;
    if (tool === 'ink' && ink.length > 1) {
      onAdd(
        createAnnot({
          page: pageIndex,
          kind: 'ink',
          points: ink.map((p) => ({ x: p.x / width, y: p.y / height })),
        })
      );
    } else if (drag) {
      const rect = cssRectToNorm(
        {
          left: Math.min(drag.x0, drag.x1),
          top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
        },
        width,
        height
      );
      // Ignore accidental micro-drags (a click, not a selection).
      if (rect.w > 0.002 && rect.h > 0.002) {
        onAdd(createAnnot({ page: pageIndex, kind: tool, rects: [rect] }));
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
      style={{ pointerEvents: tool ? 'auto' : 'none', cursor: tool ? 'crosshair' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {pageAnnots.map((a) => (
        <g
          key={a.id}
          onClick={() => {
            if (!tool && onDelete) onDelete(a.id);
          }}
          style={{ cursor: !tool && onDelete ? 'pointer' : 'inherit' }}
        >
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
          fill={tool === 'highlight' ? '#ffd400' : 'none'}
          opacity={0.35}
          stroke="#e11d48"
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