import React, { useEffect, useRef, useState } from 'react';
import { loadPdfDocument, type PdfDoc } from './pdfjs';

interface PdfViewerProps {
  bytes: Uint8Array;
  onDocumentReady?: (doc: PdfDoc) => void;
  onError?: (message: string) => void;
}

/**
 * Renders every page into its own <canvas>, stacked vertically in a scroll
 * container. One scale multiplier applies to all pages.
 */
export const PdfViewer: React.FC<PdfViewerProps> = ({ bytes, onDocumentReady, onError }) => {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Load the document once per unique byte payload.
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPageCount(0);
    setLoadError(null);
    canvasRefs.current = [];

    loadPdfDocument(bytes)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setPageCount(d.numPages);
        onDocumentReady?.(d);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = String((e as Error)?.message || e);
        setLoadError(msg);
        onError?.(msg);
      });

    return () => {
      cancelled = true;
    };
    // onDocumentReady/onError are intentionally excluded: re-running the loader
    // whenever a parent re-renders would thrash the worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // (Re)paint every page when the document or the scale changes.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;

    (async () => {
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        const page = await doc.getPage(i + 1); // pdf.js pages are 1-based
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform: [number, number, number, number, number, number] | undefined =
          ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0];
        await page.render({ canvasContext: ctx, viewport, transform }).promise;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button
          className="pdf-btn"
          title="缩小"
          onClick={() => setScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)))}
        >
          −
        </button>
        <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
        <button
          className="pdf-btn"
          title="放大"
          onClick={() => setScale((s) => Math.min(4, +(s + 0.25).toFixed(2)))}
        >
          ＋
        </button>
        <button className="pdf-btn" title="适应宽度" onClick={() => setScale(1)}>
          100%
        </button>
        <span className="pdf-sep" />
        <span className="pdf-pagecount">{pageCount ? `${pageCount} 页` : '加载中…'}</span>
      </div>

      <div className="pdf-scroll">
        {loadError ? (
          <div className="pdf-error-card">
            <div className="pdf-error-icon">⚠️</div>
            <div className="pdf-error-title">无法渲染该 PDF</div>
            <div className="pdf-error-detail">{loadError}</div>
          </div>
        ) : (
          Array.from({ length: pageCount }, (_, i) => (
            <div key={i} className="pdf-page-wrap" data-page-index={i}>
              <canvas
                className="pdf-page-canvas"
                ref={(el) => {
                  canvasRefs.current[i] = el;
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};