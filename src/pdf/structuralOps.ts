/**
 * Structural PDF operations, all pure `(bytes, args) => bytes`.
 *
 * pdf-lib is used throughout; every operation loads, mutates and re-saves, so
 * the caller always gets a fresh Uint8Array it can drop into tab state.
 */
import { PDFDocument, degrees } from 'pdf-lib';

const LOAD_OPTS = { ignoreEncryption: true } as const;

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  return doc.getPageCount();
}

export async function rotatePage(
  bytes: Uint8Array,
  pageIndex: number,
  deltaDeg: 90 | 180 | 270
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  const page = doc.getPage(pageIndex);
  const next = (((page.getRotation().angle + deltaDeg) % 360) + 360) % 360;
  page.setRotation(degrees(next));
  return doc.save();
}

export async function deletePages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  // Descending order: removing a page shifts the indices of all later pages.
  for (const i of [...indices].sort((a, b) => b - a)) doc.removePage(i);
  return doc.save();
}

export async function insertBlankPage(
  bytes: Uint8Array,
  afterIndex: number,
  size?: { width: number; height: number }
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  const ref =
    size ??
    (() => {
      const safe = Math.min(Math.max(afterIndex, 0), doc.getPageCount() - 1);
      const s = doc.getPage(safe).getSize();
      return { width: s.width, height: s.height };
    })();
  doc.insertPage(Math.min(afterIndex + 1, doc.getPageCount()), [ref.width, ref.height]);
  return doc.save();
}

/** Rebuild the document with pages in the given order. */
export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, LOAD_OPTS);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, order);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  return reorderPages(bytes, indices);
}

export async function mergePdfs(docs: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of docs) {
    const src = await PDFDocument.load(bytes, LOAD_OPTS);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** Split into contiguous parts at the given 0-based cut indices. */
export async function splitAt(bytes: Uint8Array, cutIndices: number[]): Promise<Uint8Array[]> {
  const total = await pageCount(bytes);
  const cuts = [0, ...cutIndices.filter((i) => i > 0 && i < total).sort((a, b) => a - b), total];
  const parts: Uint8Array[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const range = Array.from({ length: cuts[i + 1] - cuts[i] }, (_, k) => cuts[i] + k);
    if (range.length) parts.push(await extractPages(bytes, range));
  }
  return parts;
}

export async function getMetadata(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
  };
}

export async function setMetadata(
  bytes: Uint8Array,
  meta: { title?: string; author?: string; subject?: string; keywords?: string[] }
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) doc.setKeywords(meta.keywords);
  return doc.save();
}