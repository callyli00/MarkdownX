import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { flattenAnnotations } from '../flatten';
import { createAnnot } from '../annotations';

const CJK_FONT = resolve(process.cwd(), 'public/fonts/NotoSansSC-Regular.ttf');
const hasCjkFont = existsSync(CJK_FONT);

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return doc.save();
}

describe('flattenAnnotations', () => {
  it('returns the input unchanged for an empty list', async () => {
    const src = await makePdf(1);
    expect(await flattenAnnotations(src, [])).toBe(src);
  });

  it('produces a still-parseable PDF with a highlight', async () => {
    const out = await flattenAnnotations(await makePdf(1), [
      createAnnot({ page: 0, kind: 'highlight', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] }),
    ]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  it('flattens every kind without throwing', async () => {
    const out = await flattenAnnotations(await makePdf(2), [
      createAnnot({ page: 0, kind: 'highlight', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] }),
      createAnnot({ page: 0, kind: 'underline', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] }),
      createAnnot({ page: 1, kind: 'strikeout', rects: [{ x: 0.2, y: 0.2, w: 0.3, h: 0.03 }] }),
      createAnnot({ page: 1, kind: 'ink', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.2 }] }),
    ]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
  });

  it('ignores annotations pointing at non-existent pages', async () => {
    const out = await flattenAnnotations(await makePdf(1), [
      createAnnot({ page: 9, kind: 'ink', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }),
    ]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });

  it.skipIf(!hasCjkFont)('embeds a CJK note font when bytes are supplied', async () => {
    const noteFontBytes = new Uint8Array(readFileSync(CJK_FONT));
    const out = await flattenAnnotations(
      await makePdf(1),
      [
        createAnnot({
          page: 0,
          kind: 'note',
          text: '关键假设：应力松弛源于黏弹性耗散',
          rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.12 }],
        }),
      ],
      { noteFontBytes }
    );
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasCjkFont)('subsetting keeps a CJK note cheap (far below the 10 MB source)', async () => {
    const noteFontBytes = new Uint8Array(readFileSync(CJK_FONT));
    const out = await flattenAnnotations(
      await makePdf(1),
      [createAnnot({ page: 0, kind: 'note', text: '假设', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.1 }] })],
      { noteFontBytes }
    );
    expect(out.length).toBeLessThan(2 * 1024 * 1024);
  });
});