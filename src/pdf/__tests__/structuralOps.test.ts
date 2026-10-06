import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  pageCount,
  rotatePage,
  deletePages,
  insertBlankPage,
  reorderPages,
  extractPages,
  mergePdfs,
  splitAt,
  setMetadata,
  getMetadata,
} from '../structuralOps';

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return doc.save();
}

describe('structuralOps', () => {
  it('counts pages', async () => {
    expect(await pageCount(await makePdf(3))).toBe(3);
  });

  it('rotates a page and accumulates rotation', async () => {
    const once = await rotatePage(await makePdf(1), 0, 90);
    const twice = await rotatePage(once, 0, 90);
    expect((await PDFDocument.load(twice)).getPage(0).getRotation().angle).toBe(180);
  });

  it('deletes pages by index, handling descending order internally', async () => {
    expect(await pageCount(await deletePages(await makePdf(3), [0, 2]))).toBe(1);
  });

  it('inserts a blank page after an index', async () => {
    expect(await pageCount(await insertBlankPage(await makePdf(2), 0))).toBe(3);
  });

  it('reorders pages', async () => {
    expect(await pageCount(await reorderPages(await makePdf(4), [3, 1, 0, 2]))).toBe(4);
  });

  it('extracts a subset', async () => {
    expect(await pageCount(await extractPages(await makePdf(4), [3, 1]))).toBe(2);
  });

  it('merges documents', async () => {
    expect(await pageCount(await mergePdfs([await makePdf(2), await makePdf(3)]))).toBe(5);
  });

  it('splits at cut indices', async () => {
    const parts = await splitAt(await makePdf(5), [2]);
    expect(parts).toHaveLength(2);
    expect(await pageCount(parts[0])).toBe(2);
    expect(await pageCount(parts[1])).toBe(3);
  });

  it('returns the whole document when no cut is inside range', async () => {
    const parts = await splitAt(await makePdf(3), [0, 9]);
    expect(parts).toHaveLength(1);
    expect(await pageCount(parts[0])).toBe(3);
  });

  it('round-trips metadata', async () => {
    const out = await setMetadata(await makePdf(1), { title: 'T', author: 'A' });
    const meta = await getMetadata(out);
    expect(meta.title).toBe('T');
    expect(meta.author).toBe('A');
  });
});