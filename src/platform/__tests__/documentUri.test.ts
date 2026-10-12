import { describe, it, expect } from 'vitest';
import {
  isContentUri,
  displayNameFromUri,
  extensionOf,
  isMarkdownPath,
  isPdfPath,
} from '../documentUri';

describe('document uri helpers', () => {
  it('recognises Android content URIs', () => {
    expect(isContentUri('content://com.android.providers.downloads.documents/document/12')).toBe(true);
    expect(isContentUri('C:/docs/paper.md')).toBe(false);
    expect(isContentUri('/home/u/paper.md')).toBe(false);
  });

  it('derives a display name from a Windows path, a posix path and a SAF URI', () => {
    expect(displayNameFromUri('C:/docs/paper.md')).toBe('paper.md');
    expect(displayNameFromUri('/sdcard/notes/论文.md')).toBe('论文.md');
    // SAF URIs arrive percent-encoded; showing them raw would look like garbage.
    expect(displayNameFromUri('content://com.android.doc/1/%E8%AE%BA%E6%96%87.md')).toBe('论文.md');
  });

  it('strips a query string before taking the last segment', () => {
    expect(displayNameFromUri('content://x/y/note.md?mode=rw')).toBe('note.md');
  });

  it('falls back to the raw string when there is no segment to take', () => {
    expect(displayNameFromUri('content://')).toBe('content:');
  });

  it('classifies extensions case-insensitively', () => {
    expect(extensionOf('a/b/Paper.MD')).toBe('md');
    expect(isMarkdownPath('a/b/Paper.MD')).toBe(true);
    expect(isPdfPath('a/b/Paper.PDF')).toBe(true);
    expect(isMarkdownPath('a/b/fig.png')).toBe(false);
    expect(isPdfPath('a/b/notes.md')).toBe(false);
  });

  it('treats a file with no extension as neither', () => {
    expect(extensionOf('a/b/README')).toBe('');
    expect(isMarkdownPath('a/b/README')).toBe(false);
  });
});
