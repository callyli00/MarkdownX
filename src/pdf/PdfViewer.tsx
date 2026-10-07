import React, { useEffect, useMemo, useRef, useState } from 'react';
import { loadPdfDocument, PdfTextLayer, type PdfDoc } from './pdfjs';
import { PdfAnnotLayer } from './PdfAnnotLayer';
import { createAnnot, type PdfAnnot, type AnnotKind, type NormRect, type ViewerTool } from './annotations';
import { rotatePage, deletePages, insertBlankPage } from './structuralOps';

interface PdfViewerProps {
  bytes: Uint8Array;
  annots: PdfAnnot[];
  onAnnotsChange: (next: PdfAnnot[]) => void;
  /** Structural ops produce new bytes; the parent stores them on the tab. */
  onStructuralChange: (next: Uint8Array) => void;
  /** "Extract current page" yields a NEW document -> parent owns the save dialog. */
  onExtractPage?: (pageIndex: number) => void;
  onRequestMetadata?: () => void;
  /** Flatten annotations into a shareable, non-editable copy. */
  onExportFlattened?: () => void;
  /** Merge other PDFs into a new document. */
  onMergePdfs?: () => void;
  onVisiblePageChange?: (page: number, total: number) => void;
  onDocumentReady?: (doc: PdfDoc) => void;
  onError?: (message: string) => void;
}

/** Marks created from a text selection (select text, then click once to apply). */
const isTextMarkTool = (t: ViewerTool | null): t is AnnotKind =>
  t === 'highlight' || t === 'underline' || t === 'strikeout';

const DRAW_TOOLS: { id: ViewerTool; label: string; title: string }[] = [
  { id: 'highlight', label: '高亮', title: '选中文字后，单击页面即可高亮' },
  { id: 'underline', label: '下划线', title: '选中文字后，单击页面即可加下划线' },
  { id: 'strikeout', label: '删除线', title: '选中文字后，单击页面即可加删除线' },
  { id: 'note', label: '便签', title: '在页面上拖动框选便签位置' },
  { id: 'ink', label: '墨迹', title: '在页面上按住鼠标手绘' },
];

/** Movement (CSS px) above which a mousedown→mouseup counts as a drag, not a click. */
const CLICK_SLOP = 4;

/**
 * Renders every page into a <canvas>, lays a selectable PDF.js text layer on top,
 * and overlays an annotation layer.
 *
 * Interaction model:
 *  - 选择        : pure selection (text/images). Nothing is created or deleted.
 *  - 高亮/下划线/删除线 : select text, then a single click applies the mark.
 *  - 便签/墨迹    : drag on the page.
 *  - 删除        : drag a box; every annotation it touches is removed.
 */
export const PdfViewer: React.FC<PdfViewerProps> = ({
  bytes,
  annots,
  onAnnotsChange,
  onStructuralChange,
  onExtractPage,
  onRequestMetadata,
  onExportFlattened,
  onMergePdfs,
  onVisiblePageChange,
  onDocumentReady,
  onError,
}) => {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [tool, setTool] = useState<ViewerTool | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [visiblePage, setVisiblePage] = useState(1);
  const [opError, setOpError] = useState<string | null>(null);
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  /** Text selection waiting for the confirming click. */
  const [pendingSel, setPendingSel] = useState<{ pageIndex: number; rects: NormRect[] } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const downRef = useRef<{ x: number; y: number } | null>(null);

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

    loadPdfDocument(bytes)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setPageCount(d.numPages);
        onDocumentReady?.(d);
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
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        sizes[i] = { width: cssW, height: cssH };

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
          // host must. Without it the layer misaligns with the canvas (marks land
          // off their text, worst at small scale). Do not set width/height here:
          // TextLayer.render() derives them from --scale-factor.
          textDiv.style.setProperty('--scale-factor', String(scale));
          const textLayer = new PdfTextLayer({
            textContentSource: textContent,
            container: textDiv,
            viewport,
          });
          await textLayer.render();
        }

        if (cancelled) return;
        setPageSizes(sizes.slice());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  // Report the most-visible page so the status bar can show "page x / y".
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
        setVisiblePage(best + 1);
        onVisiblePageChange?.(best + 1, pageCount);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    const wraps = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page-wrap'));
    wraps.forEach((w) => observer.observe(w));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, scale]);

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
   * next plain click commits it. A drag must not commit, otherwise you can never
   * inspect or fix the selection before marking.
   */
  const onWrapMouseUp = (e: React.MouseEvent<HTMLDivElement>, pageIndex: number) => {
    const start = downRef.current;
    const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 0;
    const wrap = e.currentTarget;

    if (moved > CLICK_SLOP) {
      if (isTextMarkTool(tool)) {
        const rects = readSelectionRects(wrap);
        if (rects.length) setPendingSel({ pageIndex, rects });
      }
      return;
    }

    if (pendingSel && pendingSel.pageIndex === pageIndex && isTextMarkTool(tool)) {
      onAnnotsChange([...annots, createAnnot({ page: pageIndex, kind: tool, rects: pendingSel.rects })]);
      setPendingSel(null);
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

  const applyStructural = async (fn: (b: Uint8Array) => Promise<Uint8Array>): Promise<void> => {
    setOpError(null);
    try {
      onStructuralChange(await fn(bytes));
    } catch (e) {
      setOpError(`操作失败：${String((e as Error)?.message || e)}`);
    }
  };

  const pickTool = (t: ViewerTool | null) => {
    setTool((cur) => (cur === t ? null : t));
    setPendingSel(null);
  };

  const toolButtons = useMemo(
    () =>
      DRAW_TOOLS.map((t) => (
        <button
          key={t.id}
          className={`pdf-btn ${tool === t.id ? 'active' : ''}`}
          title={t.title}
          onClick={() => pickTool(t.id)}
        >
          {t.label}
        </button>
      )),
    // pickTool is stable enough for this list; the only real dependency is `tool`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool]
  );

  const activeLabel = tool && tool !== 'delete' ? DRAW_TOOLS.find((t) => t.id === tool)?.label : null;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="pdf-group">
          <button
            className={`pdf-btn ${tool === null ? 'active' : ''}`}
            title="选择：自由选中文本或图片，不创建也不删除任何标注"
            onClick={() => pickTool(null)}
          >
            选择
          </button>
          {toolButtons}
          <button
            className={`pdf-btn ${tool === 'delete' ? 'active' : ''}`}
            title="框选一个区域，删除区域内的所有标注"
            onClick={() => pickTool('delete')}
          >
            框选删除
          </button>
        </span>

        <span className="pdf-sep" />

        <span className="pdf-group">
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
        </span>

        <span className="pdf-sep" />

        <span className="pdf-group">
          <button
            className="pdf-btn"
            title={`旋转第 ${visiblePage} 页 90°`}
            onClick={() => void applyStructural((b) => rotatePage(b, visiblePage - 1, 90))}
          >
            ⟳
          </button>
          <button
            className="pdf-btn"
            title={`删除第 ${visiblePage} 页`}
            onClick={() => void applyStructural((b) => deletePages(b, [visiblePage - 1]))}
          >
            🗑
          </button>
          <button
            className="pdf-btn"
            title={`在第 ${visiblePage} 页后插入空白页`}
            onClick={() => void applyStructural((b) => insertBlankPage(b, visiblePage - 1))}
          >
            ＋页
          </button>
          <button
            className="pdf-btn"
            title={`把第 ${visiblePage} 页另存为新的 PDF`}
            onClick={() => onExtractPage?.(visiblePage - 1)}
          >
            提取页
          </button>
          <button className="pdf-btn" title="编辑文档元数据" onClick={() => onRequestMetadata?.()}>
            元数据
          </button>
          <button
            className="pdf-btn"
            title="导出压平副本：标注烧进页面，任何阅读器可见但不可再编辑"
            onClick={() => onExportFlattened?.()}
          >
            导出压平
          </button>
          <button className="pdf-btn" title="选择多个 PDF 合并为一个新文档" onClick={() => onMergePdfs?.()}>
            合并 PDF…
          </button>
        </span>

        <span className="pdf-sep" />
        <span className="pdf-pagecount">
          {pageCount ? `第 ${visiblePage} / ${pageCount} 页` : '加载中…'}
          {annots.length ? ` · ${annots.length} 标注` : ''}
        </span>
      </div>

      {pendingSel ? (
        <div className="pdf-hint pending">
          已选中文字 —— 现在<b>单击页面</b>即可应用「{activeLabel}」。
        </div>
      ) : isTextMarkTool(tool) ? (
        <div className="pdf-hint">
          已选择「{activeLabel}」：先用鼠标<b>选中文字</b>，再<b>单击一次</b>即可生成标注。
        </div>
      ) : tool === 'delete' ? (
        <div className="pdf-hint">
          已选择「框选删除」：在页面上<b>拖出一个框</b>，框内的所有标注都会被删除。
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

      {opError && (
        <div className="pdf-op-error" onClick={() => setOpError(null)} title="点击关闭">
          ⚠️ {opError}
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
              style={{
                width: pageSizes[i]?.width,
                height: pageSizes[i]?.height,
              }}
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