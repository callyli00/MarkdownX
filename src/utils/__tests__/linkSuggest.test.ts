import { describe, it, expect } from 'vitest';
import { parseSuggestQuery, scoreCandidate, suggestLinks, anchorsOf, detectTrigger } from '../linkSuggest';
import { buildIndex, scanDocument } from '../workspaceIndex';

/** A vault as the app builds it: scan each note, then index the set. */
function vault(files: Record<string, string>) {
  const docs = Object.entries(files).map(([path, content]) => scanDocument(path, content));
  return buildIndex(docs);
}

const VAULT_ROOT = 'C:\\vault';

describe('parseSuggestQuery', () => {
  it('reads a bare page query', () => {
    expect(parseSuggestQuery('alp')).toEqual({ page: 'alp', anchor: '', anchorKind: null });
  });

  it('splits a heading anchor', () => {
    expect(parseSuggestQuery('alpha#引言')).toEqual({ page: 'alpha', anchor: '引言', anchorKind: 'heading' });
  });

  it('recognises a block anchor', () => {
    expect(parseSuggestQuery('alpha#^b7')).toEqual({ page: 'alpha', anchor: 'b7', anchorKind: 'block' });
  });

  it('drops |display text before matching', () => {
    expect(parseSuggestQuery('alpha#引言|别名')).toEqual({ page: 'alpha', anchor: '引言', anchorKind: 'heading' });
  });

  it('treats a leading # as "the current note"', () => {
    expect(parseSuggestQuery('#引言')).toEqual({ page: '', anchor: '引言', anchorKind: 'heading' });
  });

  it('survives non-string input', () => {
    expect(parseSuggestQuery(null as unknown as string)).toEqual({ page: '', anchor: '', anchorKind: null });
    expect(parseSuggestQuery(undefined as unknown as string)).toEqual({ page: '', anchor: '', anchorKind: null });
  });
});

describe('scoreCandidate', () => {
  it('ranks exact above prefix above mid-word', () => {
    const exact = scoreCandidate('alpha', 'alpha');
    const prefix = scoreCandidate('alphabet', 'alpha');
    const mid = scoreCandidate('my-alpha-notes', 'alpha');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(-1);
  });

  it('prefers a word boundary over a mid-word hit', () => {
    expect(scoreCandidate('my alpha', 'alpha')).toBeGreaterThan(scoreCandidate('myalpha', 'alpha'));
  });

  it('is case-insensitive', () => {
    expect(scoreCandidate('Alpha', 'ALP')).toBe(scoreCandidate('alpha', 'alp'));
  });

  it('returns -1 for no match and 1 for an empty needle', () => {
    expect(scoreCandidate('alpha', 'zzz')).toBe(-1);
    expect(scoreCandidate('alpha', '')).toBe(1);
  });

  it('returns -1 for an empty candidate', () => {
    expect(scoreCandidate('', 'a')).toBe(-1);
    expect(scoreCandidate(null as unknown as string, 'a')).toBe(-1);
  });
});

describe('suggestLinks – pages', () => {
  const index = vault({
    [`${VAULT_ROOT}\\alpha.md`]: '# Alpha\n',
    [`${VAULT_ROOT}\\beta.md`]: '---\naliases: [贝塔, beta-notes]\n---\n# Beta\n',
    [`${VAULT_ROOT}\\notes\\alphabet.md`]: '# Alphabet\n'
  });

  it('lists notes for an empty query, sorted by label', () => {
    const items = suggestLinks(index, '', `${VAULT_ROOT}\\alpha.md`);
    expect(items.map((i) => i.label)).toEqual(['alpha', 'alphabet', 'beta']);
    expect(items.every((i) => i.kind === 'page')).toBe(true);
  });

  it('ranks an exact name above a prefix match', () => {
    const items = suggestLinks(index, 'alpha', `${VAULT_ROOT}\\alpha.md`);
    expect(items[0].label).toBe('alpha');
    expect(items[1].label).toBe('alphabet');
  });

  it('matches a frontmatter alias and says so', () => {
    const items = suggestLinks(index, '贝塔', `${VAULT_ROOT}\\alpha.md`);
    expect(items[0].label).toBe('beta');
    expect(items[0].hint).toContain('别名');
    expect(items[0].insert).toBe('beta');
  });

  it('inserts a relative path when the bare name is ambiguous', () => {
    const dup = vault({
      [`${VAULT_ROOT}\\a\\note.md`]: '# one\n',
      [`${VAULT_ROOT}\\b\\note.md`]: '# two\n'
    });
    const items = suggestLinks(dup, 'note', `${VAULT_ROOT}\\a\\note.md`);
    expect(items).toHaveLength(2);
    // Two `note.md` in different folders: the bare name cannot identify one of them, so both
    // suggestions carry their vault-relative path.
    expect(items.map((i) => i.insert).sort()).toEqual(['a/note', 'b/note']);
  });

  it('clamps a nonsensical limit instead of returning nothing', () => {
    expect(suggestLinks(index, '', null, 0).length).toBe(3);
    expect(suggestLinks(index, '', null, NaN).length).toBe(3);
    expect(suggestLinks(index, '', null, 2).length).toBe(2);
  });

  it('returns nothing for a non-matching query', () => {
    expect(suggestLinks(index, 'zzz', null)).toEqual([]);
  });

  it('survives a missing index', () => {
    expect(suggestLinks(null, 'a')).toEqual([]);
    expect(suggestLinks({ docs: null } as unknown as ReturnType<typeof vault>, 'a')).toEqual([]);
  });
});

describe('suggestLinks – anchors', () => {
  const alpha = [
    '---',
    'aliases: [阿尔法]',
    '---',
    '# 引言',
    '',
    '## 方法',
    '',
    '一段结论文字 ^b7',
    ''
  ].join('\n');
  const index = vault({
    [`${VAULT_ROOT}\\alpha.md`]: alpha,
    [`${VAULT_ROOT}\\beta.md`]: '# 引言\n\n## 结果\n'
  });

  it('lists headings of the named note', () => {
    const items = suggestLinks(index, 'alpha#', `${VAULT_ROOT}\\beta.md`);
    expect(items.map((i) => i.label)).toEqual(['引言', '方法']);
    expect(items[0].insert).toBe('alpha#引言');
    expect(items[0].hint).toBe('H1');
  });

  it('filters headings by the typed anchor', () => {
    const items = suggestLinks(index, 'alpha#方', `${VAULT_ROOT}\\beta.md`);
    expect(items.map((i) => i.label)).toEqual(['方法']);
  });

  it('resolves the page through an alias so anchors work on alias links too', () => {
    const items = suggestLinks(index, '阿尔法#引言', `${VAULT_ROOT}\\beta.md`);
    expect(items.map((i) => i.label)).toEqual(['引言']);
    expect(items[0].insert).toBe('阿尔法#引言');
  });

  it('lists block ids with their caption', () => {
    const items = suggestLinks(index, 'alpha#^', `${VAULT_ROOT}\\beta.md`);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('^b7');
    expect(items[0].insert).toBe('alpha#^b7');
    expect(items[0].hint).toContain('一段结论文字');
  });

  it('uses the current note for a bare #anchor query', () => {
    const items = suggestLinks(index, '#引', `${VAULT_ROOT}\\beta.md`);
    expect(items.map((i) => i.label)).toEqual(['引言']);
    expect(items[0].insert).toBe('#引言');
  });

  it('returns nothing when the page does not exist', () => {
    expect(suggestLinks(index, 'missing#x', null)).toEqual([]);
  });

  it('returns nothing for a bare anchor query with no current document', () => {
    expect(suggestLinks(index, '#引', null)).toEqual([]);
  });
});

describe('anchorsOf', () => {
  it('flattens headings and blocks of a document', () => {
    const doc = scanDocument(`${VAULT_ROOT}\\n.md`, '# A\n\n文字 ^id1\n');
    expect(anchorsOf(doc)).toEqual([
      { insert: 'A', label: 'A' },
      { insert: '^id1', label: '^id1' }
    ]);
  });

  it('returns an empty list for a missing document', () => {
    expect(anchorsOf(null)).toEqual([]);
  });
});

describe('detectTrigger', () => {
  it('reports the open bracket position and the typed text', () => {
    const value = 'before [[alp';
    expect(detectTrigger(value, value.length)).toEqual({ start: 7, typed: 'alp' });
  });

  it('never opens for a closed link', () => {
    const value = 'see [[alpha]] now';
    expect(detectTrigger(value, value.length)).toBeNull();
  });

  it('never opens across a newline', () => {
    const value = '[[alpha' + String.fromCharCode(10) + 'beta';
    expect(detectTrigger(value, value.length)).toBeNull();
  });

  it('ignores a third bracket', () => {
    const value = '[[[x';
    expect(detectTrigger(value, value.length)).toBeNull();
  });

  it('uses the caret, not the end of the text', () => {
    const value = 'a [[alp]] b [[be';
    expect(detectTrigger(value, 7)).toEqual({ start: 2, typed: 'alp' });
  });

  it('survives junk input', () => {
    expect(detectTrigger(null, 0)).toBeNull();
    expect(detectTrigger('[[a', NaN)).toEqual({ start: 0, typed: 'a' });
    expect(detectTrigger('[[a', -5)).toBeNull();
  });
});
