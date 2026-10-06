/**
 * Annotation persistence.
 *
 * Annotations travel INSIDE the PDF, under a private catalog key, so a single
 * file carries its own annotations: re-editable after save, and safe to rename
 * or move (unlike a sidecar file the user could orphan or delete).
 *
 * The payload is base64(JSON) to keep the PDF string purely ASCII — pdf-lib's
 * PDFString is not a safe carrier for arbitrary UTF-16 text.
 */
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PdfAnnot } from './annotations';

const ANNOT_KEY = PDFName.of('MarkdownXAnnots');
const FORMAT_VERSION = 1;

interface StoredPayload { v: number; annots: PdfAnnot[]; }

function toBase64(s: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, 'utf-8').toString('base64');
}

function fromBase64(s: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(s)));
  return Buffer.from(s, 'base64').toString('utf-8');
}

/** Write annotations into the PDF (re-editable form, NOT flattened). */
export async function writeAnnotsIntoPdf(bytes: Uint8Array, annots: PdfAnnot[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const payload: StoredPayload = { v: FORMAT_VERSION, annots };
  doc.catalog.set(ANNOT_KEY, PDFString.of(toBase64(JSON.stringify(payload))));
  return doc.save();
}

/** Read annotations back out; never throws — a broken payload yields []. */
export async function readAnnotsFromPdf(bytes: Uint8Array): Promise<PdfAnnot[]> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const raw = doc.catalog.lookupMaybe(ANNOT_KEY, PDFString);
    if (!raw) return [];
    const parsed = JSON.parse(fromBase64(raw.decodeText())) as StoredPayload;
    if (parsed.v !== FORMAT_VERSION || !Array.isArray(parsed.annots)) return [];
    return parsed.annots;
  } catch {
    return [];
  }
}

/** Remove the annotation key (used by the flattened export). */
export async function stripAnnotsFromPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.catalog.delete(ANNOT_KEY);
  return doc.save();
}