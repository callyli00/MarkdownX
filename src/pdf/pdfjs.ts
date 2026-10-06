/**
 * PDF.js bootstrap.
 *
 * The worker is imported with Vite's `?url` suffix so the bundler emits it as a
 * real asset (a bare `new Worker()` on the module path would not survive the
 * build). cMaps and standard fonts are served from public/pdfjs/ (see
 * scripts/copy-pdfjs.cjs) so CJK and standard-font PDFs render offline.
 */
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

export const PDFJS_ASSET_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
} as const;

/**
 * Load a document from raw bytes.
 *
 * `bytes.slice()` is mandatory: pdf.js TRANSFERS (detaches) the underlying
 * ArrayBuffer to its worker, which would leave the caller's Uint8Array empty and
 * break re-saves. Slicing hands over a private copy.
 */
export function loadPdfDocument(bytes: Uint8Array) {
  return pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_ASSET_OPTIONS }).promise;
}

export type PdfDoc = Awaited<ReturnType<typeof loadPdfDocument>>;

/** pdf.js's selectable text layer, re-exported so callers need one import. */
export const PdfTextLayer = pdfjsLib.TextLayer;