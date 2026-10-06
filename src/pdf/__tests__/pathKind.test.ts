import { describe, it, expect } from 'vitest';
import { isPdfPath } from '../pathKind';

describe('isPdfPath', () => {
  it('detects .pdf case-insensitively', () => {
    expect(isPdfPath('C:/docs/paper.PDF')).toBe(true);
    expect(isPdfPath('a.pdf')).toBe(true);
    expect(isPdfPath('/home/x/Report.Pdf')).toBe(true);
  });

  it('rejects markdown and empty input', () => {
    expect(isPdfPath('notes.md')).toBe(false);
    expect(isPdfPath(null)).toBe(false);
    expect(isPdfPath(undefined)).toBe(false);
    expect(isPdfPath('')).toBe(false);
  });

  it('does not match a pdf substring', () => {
    expect(isPdfPath('notpdf.txt')).toBe(false);
    expect(isPdfPath('a.pdfx')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isPdfPath('  paper.pdf  ')).toBe(true);
  });
});