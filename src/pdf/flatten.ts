/**
 * Flatten annotations into a PDF's content stream ("burn them in") to produce a
 * shareable copy that every reader displays and that cannot be re-edited.
 *
 * This is deliberately NOT the default save path — the normal save keeps
 * annotations embedded and re-editable (see annotStore.ts).
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { normRectToPdf, normPointToPdf, normalizeRotation } from './coords';
import { hexToRgb, type PdfAnnot } from './annotations';

export interface FlattenOptions {
  /** Full Noto Sans SC TTF bytes. Omitted -> Helvetica fallback (Latin only). */
  noteFontBytes?: Uint8Array;
}

/**
 * Embed the note font. Bytes are passed in (rather than fetched here) so this
 * stays testable in Node and so the browser can cache the 10 MB asset.
 * `subset: true` embeds only the glyphs actually drawn.
 */
async function loadNoteFont(doc: PDFDocument, bytes?: Uint8Array) {
  if (!bytes || !bytes.length) {
    return doc.embedFont(StandardFonts.Helvetica); // Latin-only fallback
  }
  doc.registerFontkit(fontkit);
  return doc.embedFont(bytes, { subset: true });
}

export async function flattenAnnotations(
  bytes: Uint8Array,
  annots: PdfAnnot[],
  opts: FlattenOptions = {}
): Promise<Uint8Array> {
  if (!annots.length) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await loadNoteFont(doc, opts.noteFontBytes);

  for (const a of annots) {
    if (a.page < 0 || a.page >= doc.getPageCount()) continue; // page may have been deleted
    const page = doc.getPage(a.page);
    const { width, height } = page.getSize();
    const rot = normalizeRotation(page.getRotation().angle);
    const { r, g, b } = hexToRgb(a.color);
    const color = rgb(r, g, b);

    if (a.kind === 'ink') {
      for (let i = 1; i < a.points.length; i++) {
        page.drawLine({
          start: normPointToPdf(a.points[i - 1], width, height),
          end: normPointToPdf(a.points[i], width, height),
          thickness: 2,
          color,
          opacity: a.opacity,
        });
      }
      continue;
    }

    if (a.kind === 'note') {
      const first = a.rects[0] ?? { x: 0.04, y: 0.04, w: 0.24, h: 0.1 };
      const box = normRectToPdf(first, width, height, rot);
      page.drawRectangle({
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        color,
        opacity: 0.15,
        borderColor: color,
        borderWidth: 1,
      });
      // Chinese renders because the note font is Noto Sans SC (see loadNoteFont).
      page.drawText(a.text.slice(0, 200), {
        x: box.x + 4,
        y: box.y + Math.max(4, box.h - 12),
        size: 9,
        font,
        color,
      });
      continue;
    }

    for (const rect of a.rects) {
      const p = normRectToPdf(rect, width, height, rot);
      if (a.kind === 'highlight') {
        page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color, opacity: a.opacity });
      } else if (a.kind === 'underline') {
        page.drawLine({
          start: { x: p.x, y: p.y },
          end: { x: p.x + p.w, y: p.y },
          thickness: 1.5,
          color,
          opacity: a.opacity,
        });
      } else {
        // strikeout: a line through the middle of the rect
        page.drawLine({
          start: { x: p.x, y: p.y + p.h / 2 },
          end: { x: p.x + p.w, y: p.y + p.h / 2 },
          thickness: 1.5,
          color,
          opacity: a.opacity,
        });
      }
    }
  }

  return doc.save();
}