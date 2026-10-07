import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadPdfDocument, PdfTextLayer, type PdfDoc } from './pdfjs';
import { PdfAnnotLayer } from './PdfAnnotLayer';
import { createAnnot, type PdfAnnot, type AnnotKind, type NormRect, type ViewerTool } from './annotations';

interface PdfViewerProps {
  bytes: Uint8Array;
  annots: PdfAnnot[];
  onAnnotsChange: (next: PdfAnnot[]) => void;
  onVisiblePageChange?: (page: number, total: number) => void;
  onError?: (message: string) => void;
  /** Controlled by the app chrome: toolbar tool icons + status-bar zoom. */
  tool: ViewerTool | null;
  scale: number;
  onScaleChange: (next: number) => void;
  /** Increment to request printing the rendered pages at their true page size. */
  printToken: number;
  /**
   * Reports the text selection currently waiting to be marked, so the toolbar's
   * mark buttons can apply it ("select text, then press the highlighter").
   */
  onSelectionChange?: (sel: { pageIndex: number; rects: NormRect[] } | null) => void;
}

/** Marks created from a text selection (select text, then click once to apply). */
const isTextMarkTool = (t: ViewerTool | null): t is AnnotKind =>
  t === 'highlight' || t === 'underline' || t === 'strikeout';

/** Movement (CSS px) above which a mousedown→mouseup counts as a drag, not a click. */
const CLICK_SLOP = 4;

/**
 * Renders every page into a <canvas>, lays a selectable PDF.js text layer on top,
 * and overlays an annotation layer. It owns NO toolbar: the tool buttons live in the
 * app's top bar and the zoom control in the status bar, so they only exist once.
 *
 * Interaction model:
 *  - select          : pure selection (text/images). Nothing is created or deleted.
 *  - highlight/underline/strikeout : select text, then a single click applies the mark.
 *  - note / ink      : drag on the page.
 *  - delete          : drag a box; every annotation it touches is removed.
 */
export const PdfViewer: React.FC<PdfViewerProps> = ({
  bytes,
  annots,
  onAnnotsChange,
  onVisiblePageChange,
  onError,
  tool,
  scale,
  onScaleChange,
  printToken,
  onSelectionChange,
}) => {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  /** Text selection waiting for the confirming click. */
  const [pendingSel, setPendingSel] = useState<{ pageIndex: number; rects: NormRect[] } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  /** Physical page size in mm, for the print stylesheet. */
  const pageMmRef = useRef<{ w: number; h: number }[]>([]);

  const annotsRef = useRef(annots);
  useEffect(() => {
    annotsRef.current = annots;
  }, [annots]);

  // Load the document once per unique byte payload.
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPageCount(0);
    setLoadError(null);
    setPageSizes([]);
    setPendingSel(null);
    canvasRefs.current = [];
    textLayerRefs.current = [];
    pageMmRef.current = [];

    loadPdfDocument(bytes)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setPageCount(d.numPages);
        const live = annotsRef.current.filter((a) => a.page < d.numPages);
        if (live.length !== annotsRef.current.length) onAnnotsChange(live);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // Paint every page: canvas, then the selectable text layer at the same viewport.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;

    (async () => {
      const sizes: { width: number; height: number }[] = [];
      const mms: { w: number; h: number }[] = [];
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        sizes[i] = { width: cssW, height: cssH };
        // rawDims are page units at 72 dpi, so pt -> mm is the right conversion and
        // the printed sheet matches the PDF's real paper size.
        // rawDims is typed as a bare Object by pdf.js; it carries the page size in
        // page units (72 dpi), which is what the print stylesheet needs in mm.
        const rd = viewport.rawDims as unknown as { pageWidth: number; pageHeight: number };
        mms[i] = { w: (rd.pageWidth * 25.4) / 72, h: (rd.pageHeight * 25.4) / 72 };

        const canvas = canvasRefs.current[i];
        if (canvas) {
          const ratio = window.devicePixelRatio || 1;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            canvas.width = Math.floor(cssW * ratio);
            canvas.height = Math.floor(cssH * ratio);
            canvas.style.width = `${cssW}px`;
            canvas.style.height = `${cssH}px`;
            const transform: [number, number, number, number, number, number] | undefined =
              ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0];
            await page.render({ canvasContext: ctx, viewport, transform }).promise;
          }
        }

        const textDiv = textLayerRefs.current[i];
        if (textDiv) {
          if (cancelled) return;
          const textContent = await page.getTextContent();
          if (cancelled) return;
          textDiv.replaceChildren();
          // pdf.js positions every span as calc(var(--scale-factor) * Xpx) and sizes
          // the layer the same way, but it does NOT set the variable itself — the
          // host must. Without it the layer misaligns with the canvas.
          textDiv.style.setProperty('--scale-factor', String(scale));
          const textLayer = new PdfTextLayer({
            textContentSource: textContent,
            container: textDiv,
            viewport,
          });
          await textLayer.render();
        }

        if (cancelled) return;
        pageMmRef.current = mms;
        setPageSizes(sizes.slice());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  // Report the most-visible page so the status bar / inspector can act on "current".
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !pageCount) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.pageIndex || 0);
          ratios.set(idx, e.intersectionRatio);
        }
        let best = 0;
        let bestRatio = -1;
        ratios.forEach((r, i) => {
          if (r > bestRatio) {
            bestRatio = r;
            best = i;
          }
        });
        onVisiblePageChange?.(best + 1, pageCount);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    const wraps = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page-wrap'));
    wraps.forEach((w) => observer.observe(w));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, scale]);

  // Ctrl + wheel zooms. Must be a manual non-passive listener: React's onWheel is
  // passive, so preventDefault() there would be ignored and the app would zoom too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onScaleChange(Math.min(4, Math.max(0.25, +(scale - e.deltaY * 0.0015).toFixed(2))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [scale, onScaleChange]);

  // ---- printing -----------------------------------------------------------
  // Printing the live viewer would re-flow the canvases through the app's A4 print
  // stylesheet and re-paginate them. Instead each page is emitted as an image at the
  // PDF's own paper size, one per sheet, and the app chrome is hidden.
  const printPages = useCallback(async () => {
    const sources: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      const canvas = canvasRefs.current[i];
      if (canvas) sources.push(canvas.toDataURL('image/png'));
    }
    if (!sources.length) return;

    const first = pageMmRef.current[0];
    const wMm = first ? first.w : 210;
    const hMm = first ? first.h : 297;

    // Print from an ISOLATED document in a hidden iframe rather than from the app's
    // own DOM. The app's print stylesheet (A4 @page, body margins, hidden-chrome
    // rules) fights any in-document approach and produced blank / extra sheets; a
    // separate document the app CSS cannot reach removes that whole class of bug.
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    // Real size, parked OUTSIDE the viewport. A 0x0 frame is a common recipe but some
    // engines derive the print layout viewport from the frame, and a zero-size frame
    // can print blank — the exact failure we are fixing. Being off-screen (position
    // fixed) keeps it invisible without any scrollbars.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1100px;border:0;';
    document.body.appendChild(frame);

    const fdoc = frame.contentDocument;
    const fwin = frame.contentWindow;
    if (!fdoc || !fwin) {
      frame.remove();
      return;
    }

    const wStr = wMm.toFixed(2);
    const hStr = hMm.toFixed(2);
    fdoc.open();
    fdoc.write(
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        `@page { size: ${wStr}mm ${hStr}mm; margin: 0; }` +
        'html,body{margin:0;padding:0;background:#fff;}' +
        // Each image gets a box STRICTLY smaller than the page, with object-fit
        // contain. `width:100%;height:auto` looks right but overflows the moment an
        // image's aspect is a hair taller than the page — canvas rounding, or a page
        // whose size differs from the first one. Each overflow emits an almost-blank
        // extra sheet, i.e. the "one normal page, one blank page" symptom. Shrinking
        // the box by 0.6mm (0.3mm margin, invisible) makes overflow impossible for any
        // aspect ratio.
        `img{display:block;width:calc(${wStr}mm - 0.6mm);height:calc(${hStr}mm - 0.6mm);margin:0 auto;object-fit:contain;}` +
        'img:not(:last-child){page-break-after:always;break-after:page;}' +
        '</style></head><body>' +
        sources.map((s) => `<img src="${s}">`).join('') +
        '</body></html>'
    );
    fdoc.close();

    // Wait until every image in the isolated document is decoded; printing against
    // not-yet-painted images yields blank sheets.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      };
      const check = () => {
        const imgs = Array.from(fdoc.images);
        if (imgs.length >= sources.length && imgs.every((im) => im.complete && im.naturalWidth > 0)) finish();
        else window.setTimeout(check, 50);
      };
      check();
      window.setTimeout(finish, 5000); // never hang forever
    });

    fwin.focus();
    fwin.print();

    // The iframe is invisible; drop it once printing is done.
    fwin.addEventListener('afterprint', () => window.setTimeout(() => frame.remove(), 2000));
    window.setTimeout(() => frame.remove(), 120000);
  }, [pageCount]);

  const lastPrintToken = useRef(printToken);
  useEffect(() => {
    if (printToken > lastPrintToken.current) {
      lastPrintToken.current = printToken;
      void printPages();
    }
  }, [printToken, printPages]);

  /** Rectangles (normalized) of the current native text selection on `wrap`. */
  const readSelectionRects = (wrap: HTMLDivElement): NormRect[] => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    if (!wrap.contains(range.commonAncestorContainer)) return [];
    const box = wrap.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return [];
    return Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({
        x: (r.left - box.left) / box.width,
        y: (r.top - box.top) / box.height,
        w: r.width / box.width,
        h: r.height / box.height,
      }));
  };

  const onWrapMouseDown = (e: React.MouseEvent) => {
    downRef.current = { x: e.clientX, y: e.clientY };
  };

  /**
   * Two-step mark creation: the drag that makes a selection only REMEMBERS it; the
   * next plain click commits it, so the selection can still be inspected or redone.
   */
  const onWrapMouseUp = (e: React.MouseEvent<HTMLDivElement>, pageIndex: number) => {
    const start = downRef.current;
    const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 0;
    const wrap = e.currentTarget;

    if (moved > CLICK_SLOP) {
      const rects = readSelectionRects(wrap);
      if (!rects.length) return;
      if (isTextMarkTool(tool)) {
        // Tool-first flow: the highlighter is already chosen, so apply on release.
        onAnnotsChange([...annots, createAnnot({ page: pageIndex, kind: tool, rects })]);
        window.getSelection()?.removeAllRanges();
        setPendingSel(null);
        onSelectionChange?.(null);
      } else {
        // Selection-first flow: remember it so a toolbar mark button can apply it.
        setPendingSel({ pageIndex, rects });
        onSelectionChange?.({ pageIndex, rects });
      }
      return;
    }

    if (pendingSel && pendingSel.pageIndex === pageIndex && isTextMarkTool(tool)) {
      onAnnotsChange([...annots, createAnnot({ page: pageIndex, kind: tool, rects: pendingSel.rects })]);
      setPendingSel(null);
      onSelectionChange?.(null);
      window.getSelection()?.removeAllRanges();
    }
  };

  const addAnnot = (a: PdfAnnot) => {
    onAnnotsChange([...annots, a]);
    if (a.kind === 'note' && !a.text) {
      setNoteEditId(a.id);
      setNoteDraft('');
    }
  };

  const deleteAnnots = (ids: string[]) => {
    if (!ids.length) return;
    const doomed = new Set(ids);
    onAnnotsChange(annots.filter((a) => !doomed.has(a.id)));
  };

  const commitNote = () => {
    if (!noteEditId) return;
    onAnnotsChange(annots.map((x) => (x.id === noteEditId ? { ...x, text: noteDraft } : x)));
    setNoteEditId(null);
    setNoteDraft('');
  };

  const activeLabel =
    tool === 'highlight' ? '高亮'
    : tool === 'underline' ? '下划线'
    : tool === 'strikeout' ? '删除线'
    : null;

  return (
    <div className="pdf-viewer">
      {pendingSel ? (
        <div className="pdf-hint pending">
          已选中文字 —— 点击工具栏的<b>相应图标</b>（或单击页面）即可应用标注。
        </div>
      ) : activeLabel ? (
        <div className="pdf-hint">
          已选择「{activeLabel}」：先用鼠标<b>选中文字</b>，再<b>单击一次</b>即可生成标注。
        </div>
      ) : tool === 'delete' ? (
        <div className="pdf-hint">
          已选择「橡皮（删除标注）」：在页面上<b>拖出一个框</b>，框内的所有标注都会被删除。
        </div>
      ) : null}

      {noteEditId && (
        <div className="pdf-note-edit">
          <span>便签文字：</span>
          <input
            autoFocus
            value={noteDraft}
            placeholder="输入批注内容后回车（支持中文）"
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNote();
              if (e.key === 'Escape') {
                setNoteEditId(null);
                setNoteDraft('');
              }
            }}
          />
          <button className="pdf-btn" onClick={commitNote}>
            确定
          </button>
        </div>
      )}

      <div className="pdf-scroll" ref={scrollRef}>
        {loadError ? (
          <div className="pdf-error-card">
            <div className="pdf-error-icon">⚠️</div>
            <div className="pdf-error-title">无法渲染该 PDF</div>
            <div className="pdf-error-detail">{loadError}</div>
          </div>
        ) : (
          Array.from({ length: pageCount }, (_, i) => (
            <div
              key={i}
              className="pdf-page-wrap"
              data-page-index={i}
              style={{ width: pageSizes[i]?.width, height: pageSizes[i]?.height }}
              onMouseDown={onWrapMouseDown}
              onMouseUp={(e) => onWrapMouseUp(e, i)}
            >
              <canvas
                className="pdf-page-canvas"
                ref={(el) => {
                  canvasRefs.current[i] = el;
                }}
              />
              <div
                className="pdf-text-layer textLayer"
                ref={(el) => {
                  textLayerRefs.current[i] = el;
                }}
              />
              {pageSizes[i] && (
                <PdfAnnotLayer
                  pageIndex={i}
                  annots={annots}
                  width={pageSizes[i].width}
                  height={pageSizes[i].height}
                  tool={tool}
                  onAdd={addAnnot}
                  onDeleteMany={deleteAnnots}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};