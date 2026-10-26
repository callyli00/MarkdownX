import { describe, it, expect } from 'vitest';
import { sanitizeNoteName, notePathFor } from '../linkSuggest';

describe('sanitizeNoteName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeNoteName('alpha')).toBe('alpha');
    expect(sanitizeNoteName('中文 笔记')).toBe('中文 笔记');
  });

  it('replaces characters Windows rejects', () => {
    expect(sanitizeNoteName('a/b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i');
  });

  it('collapses a run of forbidden characters into one dash', () => {
    expect(sanitizeNoteName('a//b')).toBe('a-b');
  });

  it('strips leading and trailing dots, dashes and spaces', () => {
    expect(sanitizeNoteName('...note...')).toBe('note');
    expect(sanitizeNoteName('  note  ')).toBe('note');
  });

  it('falls back to a placeholder when nothing survives', () => {
    expect(sanitizeNoteName('///')).toBe('未命名');
    expect(sanitizeNoteName('   ')).toBe('未命名');
    expect(sanitizeNoteName(null)).toBe('未命名');
  });
});

describe('notePathFor', () => {
  it('creates the note next to the current document', () => {
    expect(notePathFor('C:\\vault', 'C:\\vault\\notes\\a.md', '新笔记')).toBe('C:\\vault\\notes\\新笔记.md');
  });

  it('falls back to the workspace root when the document is outside it', () => {
    expect(notePathFor('C:\\vault', 'C:\\other\\a.md', '新笔记')).toBe('C:\\vault\\新笔记.md');
  });

  it('works for a POSIX vault (Android)', () => {
    expect(notePathFor('/storage/emulated/0/notes', '/storage/emulated/0/notes/sub/a.md', 'x')).toBe(
      '/storage/emulated/0/notes/sub/x.md'
    );
  });

  it('tolerates a trailing separator on the workspace path', () => {
    expect(notePathFor('C:\\vault\\', 'C:\\vault\\a.md', 'x')).toBe('C:\\vault\\x.md');
  });

  it('sanitises the name it embeds', () => {
    expect(notePathFor('C:\\vault', 'C:\\vault\\a.md', 'a/b')).toBe('C:\\vault\\a-b.md');
  });

  it('returns an empty string without a workspace', () => {
    expect(notePathFor('', 'C:\\vault\\a.md', 'x')).toBe('');
    expect(notePathFor(null, null, 'x')).toBe('');
  });
});
