/**
 * Reading PDF bytes off disk.
 *
 * The Rust `read_file_from_path` command returns a String and would corrupt a
 * binary PDF, so bytes go through plugin-fs's `readFile` instead.
 */
import { readFile } from '@tauri-apps/plugin-fs';
import { isPdfPath } from './pathKind';

export { isPdfPath };

/**
 * A conforming PDF may have leading junk before its `%PDF` header, so the magic
 * is searched within the first 1024 bytes rather than required at offset 0.
 */
function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i + 4 <= limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) {
      return true;
    }
  }
  return false;
}

/** Read PDF bytes, rejecting empty files and obvious non-PDFs. */
export async function loadPdfBytes(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path);
  if (!bytes || bytes.length === 0) throw new Error(`empty file: ${path}`);
  if (!looksLikePdf(bytes)) throw new Error(`not a PDF file: ${path}`);
  return bytes;
}