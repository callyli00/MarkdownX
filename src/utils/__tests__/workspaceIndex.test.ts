import { describe, expect, it } from 'vitest';
import { headingSlug, resolveWikiPage, scanWikiLinks, wikiKey } from '../wikiLink';
import {
  allTags,
  backlinksOf,
  buildIndex,
  buildWikiLookup,
  docsWithTag,
  normalizePath,
  scanDocument,
  type IndexedDoc
} from '../workspaceIndex';

/**
 * These tests pin the contract the three panels (backlinks / tags / unresolved) are wired to.
 * The two things worth stating out loud, because they are what actually broke in the renderer
 * before the index existed:
 *
 *  - a heading offset is a CHARACTER offset in the raw source, so CRLF shifts it. Estimating it
 *    as `lineNumber * lineLength` works on LF and is off by one per line on Windows.
 *  - `lookup.byName` must be ordered deterministically (no `localeCompare`): the same table is
 *    cloned into the render Worker, and a different order there means a different link target
 *    for an ambiguous name, i.e. the two render paths stop being byte-identical.
 */

const V = 'C:\\vault';
const at = (name: string) => `${V}\\${name}`;

describe('scanDocument', () => {
  const md = ['# Title', '', 'Body [[Note]] #alpha', '', '## Section Two'].join('\n');

  it('extracts links, tags and headings from one document', () => {
    const doc = scanDocument(at('a.md'), md);
    expect(doc.path).toBe(at('a.md'));
    expect(doc.name).toBe('a.md');
    expect(doc.links.map((l) => l.page)).toEqual(['Note']);
    expect(doc.tags).toEqual(['alpha']);
    expect(doc.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Section Two']
    ]);
  });

  it('reports the heading offset as a character offset, not a line estimate', () => {
    const doc = scanDocument(at('a.md'), md);
    expect(doc.headings.map((h) => h.offset)).toEqual([0, md.indexOf('## Section Two')]);
    expect(doc.headings[1].offset).toBeGreaterThan(doc.headings[0].offset);
  });

  it('ignores links, tags and headings inside fenced code', () => {
    const src = ['# Real', '```', '# Not a heading', '[[Fenced]]', '#fencedTag', '```', '[[Kept]] #kept'].join('\n');
    const doc = scanDocument(at('a.md'), src);
    expect(doc.links.map((l) => l.page)).toEqual(['Kept']);
    expect(doc.tags).toEqual(['kept']);
    expect(doc.headings.map((h) => h.text)).toEqual(['Real']);
  });

  it('keeps heading ids identical to headingSlug so [[Note#Heading]] can hit them', () => {
    const doc = scanDocument(at('b.md'), '## 中文 标题');
    expect(doc.headings[0].slug).toBe(headingSlug('中文 标题'));
    const link = scanWikiLinks('[[b#中文 标题]]')[0];
    expect(link.heading).toBe('中文 标题');
    // This is the whole matching rule the panel uses: index slug vs. the link's heading.
    expect(headingSlug(link.heading)).toBe(doc.headings[0].slug);
  });

  it('trims ATX closing hashes out of the heading text', () => {
    const doc = scanDocument(at('c.md'), '## Title ##\n');
    expect(doc.headings[0].text).toBe('Title');
    expect(doc.headings[0].slug).toBe('title');
  });

  it('offsets the second line of a CRLF document by the extra carriage return', () => {
    const lf = scanDocument(at('d.md'), 'first\n## Second');
    const crlfDoc = scanDocument(at('d.md'), 'first\r\n## Second');
    expect(lf.headings[0].offset).toBe(6);
    // 'first' + '\r' + '\n' = 7 characters, so the heading starts at 7, not at 6.
    expect(crlfDoc.headings[0].offset).toBe(7);
    expect(crlfDoc.headings[0].slug).toBe(lf.headings[0].slug);
  });

  it('survives empty path and empty content', () => {
    const doc = scanDocument('', '');
    expect(doc.path).toBe('');
    expect(doc.name).toBe('');
    expect(doc.links).toEqual([]);
    expect(doc.tags).toEqual([]);
    expect(doc.headings).toEqual([]);
    expect(doc.linkPositions).toEqual([]);
  });

  it('records a 1-based line and the trimmed source line for every link', () => {
    const doc = scanDocument(at('e.md'), 'intro\n   see [[B]] and [[B#H]]   \nlast');
    expect(doc.linkPositions?.map((p) => p.line)).toEqual([2, 2]);
    expect(doc.linkPositions?.[0].context).toBe('see [[B]] and [[B#H]]');
  });

  it('does not attribute a fenced occurrence to a link with the same raw text', () => {
    // Both occurrences are literally `[[B]]`; the first one lives in a code fence.
    const doc = scanDocument(at('f.md'), '```\n[[B]]\n```\n\n[[B]]');
    expect(doc.links).toHaveLength(1);
    expect(doc.linkPositions?.[0].line).toBe(5);
  });
});

describe('buildWikiLookup', () => {
  const docs: IndexedDoc[] = [
    scanDocument(at('b\\notes.md'), ''),
    scanDocument(at('a\\notes.md'), ''),
    scanDocument(at('top.md'), '')
  ];

  it('keys byName with wikiKey and sorts candidates', () => {
    const lookup = buildWikiLookup(docs);
    expect(lookup.byName[wikiKey('Notes')]).toEqual([at('a\\notes.md'), at('b\\notes.md')]);
    expect(lookup.byName[wikiKey('Notes')]).toHaveLength(2);
    expect(lookup.byName['notes.md']).toBeUndefined();
    expect(lookup.byName.top).toEqual([at('top.md')]);
  });

  it('is independent of the order the documents were scanned in', () => {
    const reversed = buildWikiLookup([...docs].reverse());
    expect(reversed.byName.notes).toEqual(buildWikiLookup(docs).byName.notes);
  });

  it('registers vault-relative paths for [[dir/note]] links', () => {
    const lookup = buildWikiLookup([scanDocument(at('sub\\note.md'), ''), scanDocument(at('a.md'), '')]);
    expect(lookup.byPath['sub/note.md']).toBe(at('sub\\note.md'));
    expect(lookup.byPath['sub/note']).toBe(at('sub\\note.md'));
  });

  it('prefers the note in the same directory when the name is ambiguous', () => {
    const lookup = buildWikiLookup(docs);
    expect(resolveWikiPage(lookup, 'Notes', at('b\\other.md'))?.path).toBe(at('b\\notes.md'));
    const far = resolveWikiPage(lookup, 'Notes', at('z\\other.md'));
    expect(far?.ambiguous).toHaveLength(1);
  });

  it('is structured-cloneable (it is shipped to the render Worker)', () => {
    const lookup = buildWikiLookup(docs);
    const copy = structuredClone(lookup);
    expect(copy.byName.notes).toEqual(lookup.byName.notes);
    expect(copy.byPath['b/notes.md']).toBe(at('b\\notes.md'));
  });
});

describe('buildIndex backlinks', () => {
  it('points A -> B only (direction, not just presence)', () => {
    const index = buildIndex([scanDocument(at('a.md'), 'to [[B]] here'), scanDocument(at('b.md'), 'plain')]);
    const refs = backlinksOf(index, at('b.md'));
    expect(refs).toHaveLength(1);
    expect(refs[0].from).toBe(at('a.md'));
    expect(backlinksOf(index, at('a.md'))).toHaveLength(0);
  });

  it('accepts any separator or trailing slash for the queried path', () => {
    const index = buildIndex([scanDocument(at('a.md'), '[[B]]'), scanDocument(at('b.md'), '')]);
    expect(backlinksOf(index, at('b.md').split('\\').join('/'))).toHaveLength(1);
    expect(backlinksOf(index, `${at('b.md')}\\`)).toHaveLength(1);
  });

  it('reports 1-based lines and trims the context', () => {
    const src = 'intro\n   see [[B]] and [[B#H]]   \nlast';
    const index = buildIndex([scanDocument(at('a.md'), src), scanDocument(at('b.md'), '# H')]);
    const refs = backlinksOf(index, at('b.md'));
    expect(refs.map((r) => r.line)).toEqual([2, 2]);
    expect(refs[0].context).toBe('see [[B]] and [[B#H]]');
  });

  it('clips a very long context line to 200 characters', () => {
    const long = `${'x'.repeat(300)} [[B]]`;
    const index = buildIndex([scanDocument(at('a.md'), long), scanDocument(at('b.md'), '')]);
    const refs = backlinksOf(index, at('b.md'));
    expect(refs[0].context.length).toBe(200);
    expect(refs[0].context.startsWith('xxx')).toBe(true);
  });

  it('keeps one reference per occurrence', () => {
    const index = buildIndex([scanDocument(at('a.md'), '[[B]] twice [[B]]'), scanDocument(at('b.md'), '')]);
    expect(backlinksOf(index, at('b.md'))).toHaveLength(2);
  });

  it('resolves a name case-insensitively ([[NOTES]] -> notes.md)', () => {
    const index = buildIndex([scanDocument(at('notes.md'), ''), scanDocument(at('a.md'), '[[NOTES]]')]);
    expect(index.unresolved['C:/vault/a.md']).toBeUndefined();
    expect(backlinksOf(index, at('notes.md'))).toHaveLength(1);
  });

  it('resolves a path-shaped link inside the workspace', () => {
    const index = buildIndex([scanDocument(at('sub\\note.md'), ''), scanDocument(at('a.md'), '[[sub/note]]')]);
    expect(backlinksOf(index, at('sub\\note.md'))).toHaveLength(1);
    expect(index.unresolved['C:/vault/a.md']).toBeUndefined();
  });

  it('does not throw on a cyclic embed pair', () => {
    const index = buildIndex([scanDocument(at('a.md'), '![[b]]'), scanDocument(at('b.md'), '![[a]]')]);
    expect(backlinksOf(index, at('a.md'))[0].from).toBe(at('b.md'));
    expect(backlinksOf(index, at('b.md'))[0].from).toBe(at('a.md'));
  });

  it('keeps a self-link as an edge the panel can filter', () => {
    const index = buildIndex([scanDocument(at('a.md'), '[[a]]')]);
    expect(backlinksOf(index, at('a.md'))).toHaveLength(1);
  });

  it('stores documents under a normalised key but keeps the scanned path', () => {
    const doc = scanDocument(at('a.md'), '');
    const index = buildIndex([doc]);
    expect(index.docs['C:/vault/a.md'].path).toBe(at('a.md'));
    // The panels hold the scanned path; normalizePath is the documented bridge to the key.
    expect(index.docs[normalizePath(doc.path)].name).toBe('a.md');
    expect(normalizePath('C:\\\\vault\\\\a.md')).toBe('C:/vault/a.md');
    expect(normalizePath('  C:\\vault\\a.md\\  ')).toBe('C:/vault/a.md');
    expect(normalizePath('')).toBe('');
  });
});

describe('unresolved', () => {
  it('lists links to missing notes and missing attachments, but not same-page links', () => {
    const src = '[[Missing]] and ![[assets/gone.png]] and [[#Local]]';
    const index = buildIndex([scanDocument(at('a.md'), src)]);
    const list = index.unresolved['C:/vault/a.md'];
    expect(list.map((l) => l.page)).toEqual(['Missing', 'assets/gone.png']);
    expect(list[0].kind).toBe('link');
    // The panel labels this row "attachment missing"; the flag comes from ParsedWikiLink.
    expect(list[1].kind).toBe('embed');
    expect(list[1].isAttachment).toBe(true);
  });

  it('omits the source key entirely when everything resolves', () => {
    const index = buildIndex([scanDocument(at('a.md'), '[[B]]'), scanDocument(at('b.md'), '')]);
    expect(index.unresolved['C:/vault/a.md']).toBeUndefined();
  });

  it('does not let an ambiguous-but-present name fall through to unresolved', () => {
    const index = buildIndex([
      scanDocument(at('a.md'), '[[Notes]]'),
      scanDocument(at('x\\notes.md'), ''),
      scanDocument(at('y\\notes.md'), '')
    ]);
    expect(index.unresolved['C:/vault/a.md']).toBeUndefined();
    expect(backlinksOf(index, at('x\\notes.md')).length + backlinksOf(index, at('y\\notes.md')).length).toBe(1);
  });
});

describe('tags', () => {
  const index = buildIndex([
    scanDocument(at('a.md'), '#alpha #beta'),
    scanDocument(at('b.md'), '#alpha'),
    scanDocument(at('c.md'), '#gamma')
  ]);

  it('counts documents per tag, not occurrences', () => {
    expect(index.tagCounts.alpha).toBe(2);
    expect(index.tagCounts.beta).toBe(1);
    expect(index.tagCounts.gamma).toBe(1);
    expect(buildIndex([scanDocument(at('d.md'), '#x #x #x')]).tagCounts.x).toBe(1);
  });

  it('lists the documents of a tag, tolerating a leading #', () => {
    expect(docsWithTag(index, '#alpha')).toEqual([at('a.md'), at('b.md')]);
    expect(docsWithTag(index, 'gamma')).toEqual([at('c.md')]);
    expect(docsWithTag(index, 'nope')).toEqual([]);
  });

  it('sorts by count descending, then tag ascending', () => {
    expect(allTags(index)).toEqual([
      { tag: 'alpha', count: 2 },
      { tag: 'beta', count: 1 },
      { tag: 'gamma', count: 1 }
    ]);
  });

  it('orders tags with equal counts ascending regardless of insertion order', () => {
    const tags = allTags(
      buildIndex([scanDocument(at('a.md'), '#zeta #beta #omega'), scanDocument(at('b.md'), '#zeta #beta #omega')])
    );
    expect(tags.map((t) => t.tag)).toEqual(['beta', 'omega', 'zeta']);
  });
});

describe('robustness', () => {
  it('handles empty and malformed input without throwing', () => {
    const empty = buildIndex([]);
    expect(empty.docs).toEqual({});
    expect(empty.backlinks).toEqual({});
    expect(empty.tagCounts).toEqual({});
    expect(empty.unresolved).toEqual({});
    expect(backlinksOf(empty, at('a.md'))).toEqual([]);
    expect(backlinksOf(empty, '')).toEqual([]);
    expect(docsWithTag(empty, 'alpha')).toEqual([]);
    expect(allTags(empty)).toEqual([]);
    expect(buildIndex(null as unknown as IndexedDoc[]).docs).toEqual({});
    expect(buildWikiLookup(undefined as unknown as IndexedDoc[]).byName).toEqual({});
  });

  it('ignores documents without a usable path instead of indexing them under ""', () => {
    const index = buildIndex([scanDocument('', '[[x]] #tag')]);
    expect(Object.keys(index.docs)).toEqual([]);
    expect(index.tagCounts.tag).toBeUndefined();
  });

  it('does not divide a link between two documents that normalise to the same key', () => {
    const index = buildIndex([scanDocument(at('a.md'), '[[B]]'), scanDocument('C:/vault/a.md', '#tag')]);
    expect(Object.keys(index.docs)).toHaveLength(1);
    // The second scan is a duplicate of the first, so only the first scan's links/tags count.
    expect(index.unresolved['C:/vault/a.md']).toHaveLength(1);
    expect(index.tagCounts.tag).toBeUndefined();
  });

  it('tolerates a hand-built document with no link positions', () => {
    // Incremental callers (and tests) may construct an IndexedDoc themselves. Losing the
    // position degrades the row to "unknown line", it must not drop the edge or throw.
    const bare: IndexedDoc = { path: at('a.md'), name: 'a.md', links: scanWikiLinks('[[B]]'), tags: [], headings: [] };
    const index = buildIndex([bare, scanDocument(at('b.md'), '')]);
    const refs = backlinksOf(index, at('b.md'));
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(1);
    expect(refs[0].context).toBe('');
  });

  it('is structured-cloneable as a whole', () => {
    const index = buildIndex([scanDocument(at('a.md'), '[[B]] #tag'), scanDocument(at('b.md'), '')]);
    const copy = structuredClone(index);
    expect(copy.backlinks['C:/vault/b.md'][0]).toEqual({ from: at('a.md'), line: 1, context: '[[B]] #tag' });
    expect(copy.lookup.byName.b).toEqual([at('b.md')]);
    expect(copy.tagCounts.tag).toBe(1);
  });
});
