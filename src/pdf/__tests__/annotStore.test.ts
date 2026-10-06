import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { writeAnnotsIntoPdf, readAnnotsFromPdf, stripAnnotsFromPdf } from '../annotStore';
import { createAnnot } from '../annotations';

async function makePdf(pages = 1): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595.28, 841.89]);
  return d.save();
}

describe('annotStore', () => {
  it('round-trips annotations, including CJK text', async () => {
    const a = createAnnot({
      page: 0,
      kind: 'highlight',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
      text: '中文批注',
    });
    const out = await writeAnnotsIntoPdf(await makePdf(), [a]);
    const back = await readAnnotsFromPdf(out);
    expect(back).toHaveLength(1);
    expect(back[0].text).toBe('中文批注');
    expect(back[0].rects[0].w).toBeCloseTo(0.3);
    expect(back[0].kind).toBe('highlight');
  });

  it('returns [] when the PDF has no annotations', async () => {
    expect(await readAnnotsFromPdf(await makePdf())).toEqual([]);
  });

  it('strips the key', async () => {
    const out = await writeAnnotsIntoPdf(await makePdf(), [createAnnot({ page: 0, kind: 'ink' })]);
    expect(await readAnnotsFromPdf(await stripAnnotsFromPdf(out))).toEqual([]);
  });

  it('leaves a still-valid multi-page PDF', async () => {
    const out = await writeAnnotsIntoPdf(await makePdf(2), [createAnnot({ page: 1, kind: 'underline' })]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it('replaces a previous payload rather than appending', async () => {
    const first = await writeAnnotsIntoPdf(await makePdf(), [createAnnot({ page: 0, kind: 'ink' })]);
    const second = await writeAnnotsIntoPdf(first, [
      createAnnot({ page: 0, kind: 'note', text: 'a' }),
      createAnnot({ page: 0, kind: 'note', text: 'b' }),
    ]);
    expect(await readAnnotsFromPdf(second)).toHaveLength(2);
  });
});