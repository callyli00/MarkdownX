/**
 * Path/name predicates, deliberately dependency-free so they can be unit-tested
 * in a plain Node environment (no Tauri, no DOM).
 */

const PDF_EXT = /\.pdf$/i;

/** True when a path or file name ends in `.pdf` (case-insensitive). */
export function isPdfPath(pathOrName: string | null | undefined): boolean {
  return PDF_EXT.test(String(pathOrName ?? '').trim());
}