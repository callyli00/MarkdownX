import { describe, it, expect } from 'vitest';
import { extractOutline, visibleOutlineRows } from '../outline';

/**
 * The outline is derived from the raw document text, which on Windows is CRLF.
 *
 * The extraction used `line.match(/^(#{1,6})\s+(.+)$/)` over `content.split('\n')`. In
 * JavaScript `.` does NOT match `\r` (it is a line terminator) and, without the `m` flag, `$`
 * only matches at the very end of the string - so on a CRLF file the trailing `\r` made
 * `(.+)$` unsatisfiable and EVERY heading failed to match. A merged book with 395 headings
 * produced an empty outline and the "当前文档暂无标题" hint. Verified against the real file:
 * the same algorithm reported 0 headings for the CRLF bytes and 395 after LF normalisation.
 */
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

describe('extractOutline', () => {
  const doc = ['# Title', '', 'para', '## Section A', 'text', '### Deep', '## Section B'].join('\n');

  it('extracts headings from an LF document', () => {
    const items = extractOutline(doc);
    expect(items.map((i) => [i.level, i.title])).toEqual([
      [1, 'Title'], [2, 'Section A'], [3, 'Deep'], [2, 'Section B'],
    ]);
  });

  it('extracts the same headings from a CRLF document', () => {
    // The regression: this used to return [].
    const items = extractOutline(crlf(doc));
    expect(items.map((i) => [i.level, i.title])).toEqual([
      [1, 'Title'], [2, 'Section A'], [3, 'Deep'], [2, 'Section B'],
    ]);
  });

  it('reports the same line numbers for both line endings', () => {
    // Line indices feed the source-mode jump, which indexes the LF textarea: the count and
    // the indices must not depend on the file's line endings.
    expect(extractOutline(crlf(doc)).map((i) => i.line)).toEqual(extractOutline(doc).map((i) => i.line));
  });

  it('never leaves a carriage return in a title', () => {
    for (const item of extractOutline(crlf(doc))) {
      expect(item.title).not.toContain('\r');
    }
  });

  it('skips headings inside fenced code', () => {
    const md = ['# Real', '```', '# Not a heading', '```', '## Also real'].join('\n');
    expect(extractOutline(md).map((i) => i.title)).toEqual(['Real', 'Also real']);
  });

  it('skips fenced code in a CRLF document too', () => {
    const md = crlf(['# Real', '```', '# Not a heading', '```', '## Also real'].join('\n'));
    expect(extractOutline(md).map((i) => i.title)).toEqual(['Real', 'Also real']);
  });

  it('handles an empty document', () => {
    expect(extractOutline('')).toEqual([]);
  });

  it('gives every item a stable key that survives edits above it', () => {
    const before = extractOutline('# A\n\ntext\n\n## B');
    const after = extractOutline('# A\n\ninserted\n\nmore\n\n## B');
    expect(after.map((i) => i.key)).toEqual(before.map((i) => i.key));
  });

  it('disambiguates repeated headings with an occurrence counter', () => {
    const items = extractOutline('# A\n\n## B\n\n## B');
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe('visibleOutlineRows', () => {
  const items = extractOutline('# A\n\n## B\n\n### C\n\n## D');
  const rows = visibleOutlineRows(items, new Set<string>());

  it('shows everything when nothing is collapsed', () => {
    expect(rows.map((r) => r.title)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('hides only the subtree of a collapsed node', () => {
    const collapsed = new Set([items[1].key]);          // collapse 'B'
    expect(visibleOutlineRows(items, collapsed).map((r) => r.title)).toEqual(['A', 'B', 'D']);
  });

  it('reports hasChild so a caret is drawn only where it helps', () => {
    expect(rows.map((r) => r.hasChild)).toEqual([true, true, false, false]);
  });

  it('keeps a collapsed node itself visible', () => {
    const collapsed = new Set([items[0].key]);
    const visible = visibleOutlineRows(items, collapsed);
    expect(visible[0].title).toBe('A');
    expect(visible[0].collapsed).toBe(true);
    expect(visible.length).toBe(1);
  });

  it('ignores keys that do not belong to this document', () => {
    // Collapse state is keyed per document; a key from another file must have no effect.
    const collapsed = new Set(['other-file::1:Title#0']);
    expect(visibleOutlineRows(items, collapsed).map((r) => r.title)).toEqual(['A', 'B', 'C', 'D']);
  });
});