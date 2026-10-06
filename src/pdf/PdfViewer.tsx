import React, { useEffect, useMemo, useRef, useState } from 'react';
import { loadPdfDocument, type PdfDoc } from './pdfjs';
import { PdfAnnotLayer } from './PdfAnnotLayer';
import type { PdfAnnot, AnnotKind } from './annotations';
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
  onVisiblePageChange?: (page: number, total: number) => void;
  onDocumentReady?: (doc: PdfDoc) => void;
  onError?: (message: string) => void;
}

const TOOLS: { id: AnnotKind; label: string; title: string }[] = [
  { id: 'highlight', label: '高亮', title: '拖动框选高亮' },
  { id: 'underline', label: '下划线', title: '拖动框选下划线' },
  { id: 'strikeout', label: '删除线', title: '拖动框选删除线' },
  { id: 'note', label: '便签', title: '拖动框选放置便签' },
  { id: 'ink', label: '墨迹', title: '按住手绘' },
];

/**
 * Renders every page into its own <canvas>, stacks them in a scroll container and
 * overlays an annotation layer per page. One scale multiplier applies to all pages.
 */
export const PdfViewer: React.FC<PdfViewerProps> = ({
  bytes,
  annots,
  onAnnotsChange,
  onStructuralChange,
  onExtractPage,
  onRequestMetadata,
  onExportFlattened,
  onVisiblePageChange,
  onDocumentReady,
  onError,
}) => {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [tool, setTool] = useState<AnnotKind | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [visiblePage, setVisiblePage] = useState(1);
  const [opError, setOpError] = useState<string | null>(null);
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Keep the newest annots reachable from the load effect without re-running it.
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
    canvasRefs.current = [];

    loadPdfDocument(bytes)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setPageCount(d.numPages);
        onDocumentReady?.(d);
        // Structural edits can strand annotations on pages that no longer exist.
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
    // onDocumentReady/onError/onAnnotsChange are intentionally excluded: re-running
    // the loader on every parent render would thrash the worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // Paint every page when the document or the scale changes; record page sizes so
  // the annotation overlay matches its canvas exactly.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;

    (async () => {
      const sizes: { width: number; height: number }[] = [];
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i + 1); // pdf.js pages are 1-based
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

  const addAnnot = (a: PdfAnnot) => {
    onAnnotsChange([...annots, a]);
    if (a.kind === 'note' && !a.text) {
      setNoteEditId(a.id);
      setNoteDraft('');
    }
  };

  const commitNote = () => {
    if (!noteEditId) return;
    onAnnotsChange(annots.map((x) => (x.id === noteEditId ? { ...x, text: noteDraft } : x)));
    setNoteEditId(null);
    setNoteDraft('');
  };

  const deleteAnnot = (id: string) => {
    onAnnotsChange(annots.filter((x) => x.id !== id));
  };

  const applyStructural = async (fn: (b: Uint8Array) => Promise<Uint8Array>): Promise<void> => {
    setOpError(null);
    try {
      onStructuralChange(await fn(bytes));
    } catch (e) {
      setOpError(`操作失败：${String((e as Error)?.message || e)}`);
    }
  };

  const toolButtons = useMemo(
    () =>
      TOOLS.map((t) => (
        <button
          key={t.id}
          className={`pdf-btn ${tool === t.id ? 'active' : ''}`}
          title={t.title}
          onClick={() => setTool((cur) => (cur === t.id ? null : t.id))}
        >
          {t.label}
        </button>
      )),
    [tool]
  );

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="pdf-group">
          {toolButtons}
          <button
            className={`pdf-btn ${tool === null ? 'active' : ''}`}
            title="选择：点击一个标注即可删除它"
            onClick={() => setTool(null)}
          >
            选择
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
        </span>

        <span className="pdf-sep" />
        <span className="pdf-pagecount">
          {pageCount ? `第 ${visiblePage} / ${pageCount} 页` : '加载中…'}
          {annots.length ? ` · ${annots.length} 标注` : ''}
        </span>
      </div>

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
            >
              <canvas
                className="pdf-page-canvas"
                ref={(el) => {
                  canvasRefs.current[i] = el;
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
                  onDelete={deleteAnnot}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};