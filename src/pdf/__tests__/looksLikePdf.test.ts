import { describe, it, expect } from 'vitest';
import { looksLikePdf } from '../openPdf';

const bytesOf = (s: string) => new TextEncoder().encode(s);

describe('looksLikePdf', () => {
  it('accepts a header at offset 0', () => {
    expect(looksLikePdf(bytesOf('%PDF-1.7\n...'))).toBe(true);
  });

  it('accepts a header after leading junk', () => {
    // A conforming PDF may carry junk before %PDF, so the magic must be searched, not
    // required at offset 0.
    expect(looksLikePdf(bytesOf('junk'.repeat(20) + '%PDF-1.4'))).toBe(true);
  });

  it('accepts a header that still fits inside the 1024-byte window', () => {
    expect(looksLikePdf(bytesOf('x'.repeat(1000) + '%PDF'))).toBe(true);
  });

  it('rejects a header beyond the 1024-byte window', () => {
    expect(looksLikePdf(bytesOf('x'.repeat(2000) + '%PDF'))).toBe(false);
  });

  it('rejects text and empty input', () => {
    expect(looksLikePdf(bytesOf('# just markdown\n\nhello'))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });

  it('rejects a truncated header', () => {
    expect(looksLikePdf(bytesOf('%PD'))).toBe(false);
  });
});
