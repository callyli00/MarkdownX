import { describe, expect, it } from 'vitest';
import {
  parseVaultQuery,
  planReplace,
  searchVault,
  type ParsedQuery,
  type SearchDoc,
  type SearchHit
} from '../vaultSearch';

/**
 * These tests pin the search contract the panel is wired to. The three things that are easy to
 * get subtly wrong, and that this file therefore asserts explicitly:
 *
 *  - a hit's `offset` is a CHARACTER offset into `content`, so CRLF shifts it by one per line,
 *    while `line`/`column` are 1-based and taken from the line WITHOUT its trailing `\r`;
 *  - several words are a same-line AND, so `foo bar` must not match a document whose `foo` and
 *    `bar` live on different lines;
 *  - `planReplace` splices from the END, because a left-to-right splice with a longer
 *    replacement invalidates every later offset on that line.
 */

const V = 'C:\\vault';
const at = (name: string) => `${V}\\${name}`;
/** Base name, the way the vault walker fills `SearchDoc.name`. */
const base = (name: string) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);

const doc = (name: string, content: string, extra?: { tags?: string[] }): SearchDoc => ({
  path: at(name),
  name: base(name),
  content,
  ...(extra ?? {})
});

/** `HeadingRef`-shaped headings: `level` is extra data the module honours for section ranges. */
const withHeadings = (
  name: string,
  content: string,
  headings: Array<{ text: string; slug: string; offset: number; level?: number }>
): SearchDoc => ({ path: at(name), name: base(name), content, headings });

const run = (docs: SearchDoc[], query: string, limit?: number) =>
  searchVault(docs, parseVaultQuery(query), limit === undefined ? undefined : { limit });

const hitAt = (offset: number, length: number, path = at('a.md')): SearchHit => ({
  path,
  name: 'a.md',
  line: 1,
  column: 1,
  offset,
  length,
  text: '',
  context: ''
});

describe('parseVaultQuery', () => {
  it('splits free words into a single text query', () => {
    const q = parseVaultQuery('  alpha   beta  ');
    expect(q.text).toBe('alpha beta');
    expect(q.raw).toBe('  alpha   beta  ');
    expect(q.phrases).toEqual([]);
    expect(q.regex).toBeNull();
    expect(q.tags).toEqual([]);
    expect(q.tasks).toBeNull();
    expect(q.caseSensitive).toBe(false);
    expect(q.wholeWord).toBe(false);
  });

  it('keeps a quoted phrase verbatim, spaces included', () => {
    const q = parseVaultQuery('"alpha beta" gamma');
    expect(q.phrases).toEqual(['alpha beta']);
    expect(q.text).toBe('gamma');
  });

  it('reads tag:/path:/file:/section: and strips the # from tag and section values', () => {
    const q = parseVaultQuery('tag:#alpha tag:"Beta Notes" path:sub/daily file:*.md section:"## Usage"');
    expect(q.tags).toEqual(['alpha', 'Beta Notes']);
    expect(q.paths).toEqual(['sub/daily']);
    expect(q.files).toEqual(['*.md']);
    expect(q.sections).toEqual(['Usage']);
  });

  it('reads task:todo and task:done, and keeps an unknown state as searchable text', () => {
    expect(parseVaultQuery('task:todo x').tasks).toBe('todo');
    expect(parseVaultQuery('task:done x').tasks).toBe('done');
    const unknown = parseVaultQuery('task:someday');
    expect(unknown.tasks).toBeNull();
    // Dropping the token would give the user silent zero results; searching for it explains itself.
    expect(unknown.text).toBe('task:someday');
  });

  it('collects -word and -"phrase" into exclude, leaving text clean', () => {
    const q = parseVaultQuery('keep -draft -"in progress"');
    expect(q.text).toBe('keep');
    expect(q.exclude).toEqual(['draft', 'in progress']);
  });

  it('compiles /regex/ case-insensitively by default and never stores a global flag', () => {
    const q = parseVaultQuery('/(a|b)c/');
    expect(q.regex).not.toBeNull();
    expect(q.regex?.source).toBe('(a|b)c');
    expect(q.regex?.flags).toBe('i');
    expect(q.regex?.test('AC')).toBe(true);
  });

  it('drops the g flag so a stored regex can be reused without lastIndex surprises', () => {
    const q = parseVaultQuery('/fo+/g');
    expect(q.regex?.flags).toBe('i');
    expect(q.regex?.flags.includes('g')).toBe(false);
    const pattern = q.regex;
    if (!pattern) throw new Error('expected a compiled regex');
    expect(pattern.test('foo')).toBe(true);
    // A stateless regex answers the same thing twice; a global one would not.
    expect(pattern.test('foo')).toBe(true);
  });

  it('lets an explicit i flag win over match-case:', () => {
    const q = parseVaultQuery('/FOO/i match-case:');
    expect(q.caseSensitive).toBe(true);
    expect(q.regex?.flags).toBe('i');
  });

  it('applies match-case: and whole-word: no matter where they appear', () => {
    const trailing = parseVaultQuery('/Foo/ match-case: whole-word:');
    expect(trailing.caseSensitive).toBe(true);
    expect(trailing.wholeWord).toBe(true);
    expect(trailing.regex?.flags).toBe('');
    const leading = parseVaultQuery('match-case: /Foo/');
    expect(leading.regex?.flags).toBe('');
    // The bare toggle takes no value; a value attached to it is part of the toggle, not a word.
    expect(parseVaultQuery('match-case:foo').caseSensitive).toBe(true);
  });

  it('turns a toggle off when it is negated or given a false value', () => {
    expect(parseVaultQuery('x match-case: match-case:false').caseSensitive).toBe(false);
    expect(parseVaultQuery('x whole-word: -whole-word:').wholeWord).toBe(false);
  });

  it('searches an invalid regex literally instead of throwing', () => {
    const q = parseVaultQuery('/foo(/');
    expect(q.regex).toBeNull();
    expect(q.phrases).toEqual(['foo(']);
  });

  it('leaves a prose slash alone (and/or is a word, not a regex)', () => {
    expect(parseVaultQuery('and/or').text).toBe('and/or');
    expect(parseVaultQuery('/foo bar').text).toBe('/foo bar');
  });

  it('treats an unknown operator-shaped token as ordinary text', () => {
    const q = parseVaultQuery('http://example.com');
    expect(q.text).toBe('http://example.com');
    expect(q.tags).toEqual([]);
  });

  it('returns usable defaults for an empty or non-string query', () => {
    const empty = parseVaultQuery('');
    expect(empty.text).toBe('');
    expect(empty.raw).toBe('');
    expect(empty.regex).toBeNull();
    expect(empty.phrases).toEqual([]);
    expect(empty.exclude).toEqual([]);
    expect(empty.tasks).toBeNull();
    expect(parseVaultQuery(undefined as unknown as string).text).toBe('');
  });
});

describe('searchVault positions', () => {
  it('reports 1-based line/column, a character offset, the matched text and the trimmed line', () => {
    const res = run([doc('a.md', 'intro\n   foo bar\n')], 'foo');
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0];
    // 'intro\n' is 6 code units, then three spaces: offset 9, column 4.
    expect([hit.line, hit.column, hit.offset, hit.length, hit.text, hit.context]).toEqual([
      2, 4, 9, 3, 'foo', 'foo bar'
    ]);
    expect(hit.path).toBe(at('a.md'));
    expect(hit.name).toBe('a.md');
  });

  it('shifts offsets by the extra \\r on a CRLF document but keeps the same line/column', () => {
    const lf = run([doc('lf.md', 'intro\nfoo bar\n')], 'foo').hits[0];
    const crlf = run([doc('crlf.md', 'intro\r\nfoo bar\r\n')], 'foo').hits[0];
    expect(lf.offset).toBe(6);
    // 'intro' + '\r' + '\n' = 7 code units, so the second line starts at 7, not 6.
    expect(crlf.offset).toBe(7);
    expect([crlf.line, crlf.column]).toEqual([2, 1]);
    // The trailing \r is not part of the line, so it must not survive into the context.
    expect(crlf.context).toBe('foo bar');
  });

  it('reports every occurrence on a line, ordered left to right', () => {
    const hits = run([doc('a.md', 'foo bar foo')], 'foo').hits;
    expect(hits.map((h) => [h.column, h.offset])).toEqual([
      [1, 0],
      [9, 8]
    ]);
  });

  it('clips a long context to 200 characters after trimming', () => {
    const line = `${'x'.repeat(300)} foo`;
    const hit = run([doc('a.md', `${line}\n`)], 'foo').hits[0];
    expect(hit.context.length).toBe(200);
    expect(hit.context.startsWith('xxx')).toBe(true);
    expect(hit.column).toBe(302);
  });

  it('falls back to the basename when the document carries no name', () => {
    const hit = run([{ path: at('x.md'), name: '', content: 'foo' }], 'foo').hits[0];
    expect(hit.name).toBe('x.md');
  });
});

describe('searchVault matching rules', () => {
  it('matches case-insensitively by default', () => {
    const hits = run([doc('a.md', 'FOO')], 'foo').hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('FOO');
  });

  it('honours match-case:', () => {
    expect(run([doc('a.md', 'FOO foo')], 'foo match-case:').hits.map((h) => h.column)).toEqual([5]);
  });

  it('requires a word boundary with whole-word:', () => {
    const hits = run([doc('a.md', 'cat category cat')], 'cat whole-word:').hits;
    expect(hits.map((h) => h.offset)).toEqual([0, 13]);
  });

  it('treats non-ASCII characters as word characters for whole-word:', () => {
    // `中文` inside `中文测试` has no right boundary; the standalone one does.
    const hits = run([doc('a.md', '中文测试 中文')], '中文 whole-word:').hits;
    expect(hits.map((h) => h.offset)).toEqual([5]);
  });

  it('is a same-line AND: words on different lines do not match', () => {
    expect(run([doc('a.md', 'foo\nbar\n')], 'foo bar').hits).toHaveLength(0);
    const same = run([doc('a.md', 'bar foo\n')], 'foo bar').hits;
    // Both terms are reported, in reading order.
    expect(same.map((h) => [h.text, h.offset])).toEqual([
      ['bar', 0],
      ['foo', 4]
    ]);
  });

  it('matches a quoted phrase as one contiguous run', () => {
    const hit = run([doc('a.md', 'the alpha and beta run\n')], '"alpha and beta"').hits[0];
    expect([hit.offset, hit.length, hit.text]).toEqual([4, 14, 'alpha and beta']);
    expect(run([doc('a.md', 'alpha\nand beta')], '"alpha and beta"').hits).toHaveLength(0);
  });

  it('finds every regex match, with the matched length', () => {
    const hits = run([doc('a.md', 'a1 b22 c333')], '/\\d+/').hits;
    expect(hits.map((h) => [h.offset, h.length])).toEqual([
      [1, 1],
      [4, 2],
      [8, 3]
    ]);
  });

  it('skips zero-width regex matches instead of looping forever', () => {
    expect(run([doc('a.md', 'foo bar')], '/(?=foo)/').hits).toHaveLength(0);
    expect(run([doc('a.md', 'foo bar')], '/^/').hits).toHaveLength(0);
  });

  it('collapses a repeated identical term into one hit per occurrence', () => {
    expect(run([doc('a.md', 'foo')], 'foo foo').hits).toHaveLength(1);
    expect(run([doc('a.md', 'foo foo')], 'foo foo').hits).toHaveLength(2);
  });
});

describe('searchVault filters', () => {
  const tagged = [
    doc('a.md', 'foo', { tags: ['project/alpha'] }),
    doc('b.md', 'foo', { tags: ['other'] })
  ];

  it('applies tag: with nesting (tag:project matches project/alpha)', () => {
    expect(run(tagged, 'foo tag:project').hits.map((h) => h.path)).toEqual([at('a.md')]);
    expect(run(tagged, 'foo tag:project/alpha').hits.map((h) => h.path)).toEqual([at('a.md')]);
    expect(run(tagged, 'foo tag:PROJECT').hits).toHaveLength(1);
  });

  it('applies path: as a substring or as a glob', () => {
    const docs = [doc('sub/note.md', 'foo'), doc('top.md', 'foo')];
    expect(run(docs, 'foo path:sub').hits.map((h) => h.name)).toEqual(['note.md']);
    expect(run(docs, 'foo path:sub/*.md').hits.map((h) => h.name)).toEqual(['note.md']);
    expect(run(docs, 'foo path:**/top.md').hits.map((h) => h.name)).toEqual(['top.md']);
    expect(run(docs, 'foo path:nowhere').hits).toHaveLength(0);
  });

  it('applies file: to the base name only', () => {
    const docs = [doc('sub/note.md', 'foo'), doc('sub/other.txt', 'foo')];
    expect(run(docs, 'foo file:*.md').hits.map((h) => h.name)).toEqual(['note.md']);
    expect(run(docs, 'foo file:other').hits.map((h) => h.name)).toEqual(['other.txt']);
  });

  it('limits section: to the heading span and stops at the next same-level heading', () => {
    const content = '# One\nalpha\n\n## Two\nbeta\n\n## Three\nalpha\n';
    const heading = (level: number, text: string) => ({
      text,
      slug: text.toLowerCase(),
      offset: content.indexOf(`${'#'.repeat(level)} ${text}`),
      level
    });
    const docs = [withHeadings('a.md', content, [heading(1, 'One'), heading(2, 'Two'), heading(2, 'Three')])];
    expect(docs[0].headings?.every((h) => h.offset >= 0)).toBe(true);

    // `alpha` also appears in Two's neighbour sections; section:Two must not see it.
    expect(run(docs, 'section:Two alpha').hits).toHaveLength(0);
    expect(run(docs, 'section:Two beta').hits.map((h) => h.line)).toEqual([5]);
    expect(run(docs, 'section:Three alpha').hits.map((h) => h.line)).toEqual([8]);
    // One is a level-1 heading, so its span swallows both level-2 sections.
    expect(run(docs, 'section:One alpha').hits.map((h) => h.line)).toEqual([2, 8]);
  });

  it('ends a section at the next heading when the headings carry no level', () => {
    const content = '# One\nalpha\n\n## Two\nbeta\n\n## Three\nalpha\n';
    const bare = (marker: string, text: string) => ({
      text,
      slug: text.toLowerCase(),
      offset: content.indexOf(`${marker} ${text}`)
    });
    const docs = [withHeadings('a.md', content, [bare('#', 'One'), bare('##', 'Two'), bare('##', 'Three')])];
    expect(run(docs, 'section:One alpha').hits.map((h) => h.line)).toEqual([2]);
  });

  it('matches a section by slug as well as by heading text', () => {
    const content = '## Usage Notes\nstuff\n';
    const docs = [withHeadings('a.md', content, [{ text: 'Usage Notes', slug: 'usage-notes', offset: 0 }])];
    expect(run(docs, 'section:usage-notes stuff').hits).toHaveLength(1);
    expect(run(docs, 'section:usage stuff').hits).toHaveLength(0);
  });

  it('restricts task:todo / task:done to real checkbox lines', () => {
    const content = '- [ ] open task\n- [x] done task\n* [ ] another\nplain task\n';
    const docs = [doc('a.md', content)];
    expect(run(docs, 'task:todo task').hits.map((h) => h.line)).toEqual([1]);
    expect(run(docs, 'task:done task').hits.map((h) => h.line)).toEqual([2]);
    // A `*` bullet is a task too, so the marker set is not just `-`.
    expect(run(docs, 'task:todo another').hits.map((h) => h.line)).toEqual([3]);
    // A line that is a task but mentions nothing else is not a text match.
    expect(run(docs, 'task:todo').hits).toHaveLength(0);
  });

  it('drops a line containing an excluded word or phrase', () => {
    const content = 'keep this\nkeep that draft\nkeep that draft too\n';
    const docs = [doc('a.md', content)];
    expect(run(docs, 'keep -draft').hits.map((h) => h.line)).toEqual([1]);
    expect(run(docs, 'keep -"that draft"').hits.map((h) => h.line)).toEqual([1]);
    // exclude follows the case sensitivity of the query, it is not always insensitive:
    // without match-case: `-DRAFT` lowercases to `draft` and drops two lines, with it only the
    // literal `DRAFT` would be dropped (and nothing is).
    expect(run(docs, 'keep -DRAFT').hits.map((h) => h.line)).toEqual([1]);
    expect(run(docs, 'keep -DRAFT match-case:').hits).toHaveLength(3);
  });

  it('returns nothing for a filter-only query (there is no line to point at)', () => {
    expect(run([doc('a.md', 'foo', { tags: ['x'] })], 'tag:x').hits).toHaveLength(0);
    expect(run([doc('a.md', 'foo')], 'path:a').hits).toHaveLength(0);
  });
});

describe('searchVault bounds', () => {
  const manyLines = (n: number) => Array.from({ length: n }, () => 'x').join('\n');

  it('applies limit to hits but still counts the total', () => {
    const res = run([doc('a.md', manyLines(10))], 'x', 3);
    expect(res.hits).toHaveLength(3);
    expect(res.total).toBe(10);
    expect(res.truncated).toBe(true);
    expect(res.filesWithHits).toBe(1);
  });

  it('reports truncated=false when everything fit', () => {
    const res = run([doc('a.md', manyLines(10))], 'x');
    expect(res.hits).toHaveLength(10);
    expect(res.total).toBe(10);
    expect(res.truncated).toBe(false);
  });

  it('stops counting the total at 5000', () => {
    const res = run([doc('a.md', manyLines(5001))], 'x');
    expect(res.total).toBe(5000);
    expect(res.hits).toHaveLength(200);
    expect(res.truncated).toBe(true);
  });

  it('skips a document body over 2 MB', () => {
    const huge = `foo ${'x'.repeat(2 * 1024 * 1024)}`;
    const res = run([doc('huge.md', huge), doc('small.md', 'foo')], 'foo');
    expect(res.hits.map((h) => h.name)).toEqual(['small.md']);
    expect(res.filesWithHits).toBe(1);
  });

  it('keeps documents in input order and counts files with hits', () => {
    const res = run([doc('b.md', 'foo'), doc('a.md', 'foo\nfoo'), doc('c.md', 'nope')], 'foo');
    expect(res.hits.map((h) => h.name)).toEqual(['b.md', 'a.md', 'a.md']);
    expect(res.filesWithHits).toBe(2);
  });

  it('skips documents with no usable path and tolerates missing content', () => {
    const docs = [
      { path: '', name: 'ghost.md', content: 'foo' },
      { path: at('a.md'), name: 'a.md', content: undefined as unknown as string }
    ];
    const res = searchVault(docs, parseVaultQuery('foo'));
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('returns an empty result for empty input or a null query', () => {
    const emptyDocs = searchVault([], parseVaultQuery('foo'));
    expect(emptyDocs.hits).toEqual([]);
    expect(emptyDocs.total).toBe(0);
    expect(emptyDocs.filesWithHits).toBe(0);
    expect(searchVault(null as unknown as SearchDoc[], parseVaultQuery('foo')).hits).toEqual([]);
    expect(searchVault([doc('a.md', 'foo')], null as unknown as ParsedQuery).hits).toEqual([]);
    expect(searchVault([doc('a.md', 'foo')], {} as unknown as ParsedQuery).hits).toEqual([]);
  });

  it('does not throw on an empty document', () => {
    const res = run([doc('a.md', '')], 'foo');
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });
});

describe('planReplace', () => {
  it('replaces every hit and reports the count, keeping before/after', () => {
    const docs = [doc('a.md', 'foo bar\nfoo\n')];
    const hits = searchVault(docs, parseVaultQuery('foo')).hits;
    const edits = planReplace(docs, hits, 'X');
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe(at('a.md'));
    expect(edits[0].before).toBe('foo bar\nfoo\n');
    expect(edits[0].after).toBe('X bar\nX\n');
    expect(edits[0].count).toBe(2);
    // Pure: the input document is untouched.
    expect(docs[0].content).toBe('foo bar\nfoo\n');
  });

  it('splices from the end so a longer replacement cannot corrupt later offsets', () => {
    const docs = [doc('a.md', 'foo foo')];
    const edits = planReplace(docs, searchVault(docs, parseVaultQuery('foo')).hits, 'LONGER');
    expect(edits[0].after).toBe('LONGER LONGER');
    expect(edits[0].count).toBe(2);
  });

  it('preserves CRLF', () => {
    const docs = [doc('a.md', 'foo\r\nbar foo\r\n')];
    const edits = planReplace(docs, searchVault(docs, parseVaultQuery('foo')).hits, 'X');
    expect(edits[0].after).toBe('X\r\nbar X\r\n');
    expect(edits[0].count).toBe(2);
  });

  it('treats the replacement as literal text, not as a regex template', () => {
    const docs = [doc('a.md', 'foo')];
    const edits = planReplace(docs, searchVault(docs, parseVaultQuery('foo')).hits, '$&X');
    expect(edits[0].after).toBe('$&X');
  });

  it('emits one edit per document, in document order, and only for documents with hits', () => {
    const docs = [doc('b.md', 'foo foo'), doc('a.md', 'nothing'), doc('c.md', 'foo')];
    const edits = planReplace(docs, searchVault(docs, parseVaultQuery('foo')).hits, 'X');
    expect(edits.map((e) => e.path)).toEqual([at('b.md'), at('c.md')]);
    expect(edits.map((e) => e.count)).toEqual([2, 1]);
  });

  it('applies a duplicated hit once', () => {
    const docs = [doc('a.md', 'abc')];
    const edits = planReplace(docs, [hitAt(0, 3), hitAt(0, 3)], 'X');
    expect(edits[0].count).toBe(1);
    expect(edits[0].after).toBe('X');
  });

  it('skips an overlapping hit instead of editing text the user did not select', () => {
    const docs = [doc('a.md', 'abcdef')];
    // Descending order applies [2,5) first; [0,3) would overlap it, so it is dropped.
    const edits = planReplace(docs, [hitAt(0, 3), hitAt(2, 3)], 'X');
    expect(edits[0].count).toBe(1);
    expect(edits[0].after).toBe('abXf');
  });

  it('ignores out-of-range, zero-length and foreign-path hits', () => {
    const docs = [doc('a.md', 'abc')];
    expect(planReplace(docs, [hitAt(99, 2)], 'X')).toEqual([]);
    expect(planReplace(docs, [hitAt(1, 0)], 'X')).toEqual([]);
    expect(planReplace(docs, [hitAt(0, 3, at('elsewhere.md'))], 'X')).toEqual([]);
    expect(planReplace(docs, [], 'X')).toEqual([]);
    expect(planReplace(null as unknown as SearchDoc[], [hitAt(0, 1)], 'X')).toEqual([]);
  });

  it('matches hits to documents through a normalised path', () => {
    const docs = [doc('a.md', 'foo')];
    const forward = { ...hitAt(0, 3), path: 'C:/vault/a.md' };
    const edits = planReplace(docs, [forward], 'X');
    expect(edits[0].after).toBe('X');
  });

  it('replaces several words of a multi-word query independently', () => {
    const docs = [doc('a.md', 'bar foo\n')];
    const edits = planReplace(docs, searchVault(docs, parseVaultQuery('foo bar')).hits, 'z');
    expect(edits[0].after).toBe('z z\n');
    expect(edits[0].count).toBe(2);
  });
});
