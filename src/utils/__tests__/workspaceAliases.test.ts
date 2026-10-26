import { describe, it, expect } from 'vitest';
import {
  buildIndex,
  buildWikiLookup,
  parseAliases,
  scanBlockIds,
  normalizePath,
  scanDocument
} from '../workspaceIndex';
import { resolveWikiPage } from '../wikiLink';

const A = 'C:\\vault\\alpha.md';
const B = 'C:\\vault\\beta.md';

describe('parseAliases', () => {
  it('reads an inline bracket list', () => {
    expect(parseAliases('---\naliases: [阿尔法, alpha]\n---\nbody\n')).toEqual(['阿尔法', 'alpha']);
  });

  it('reads a comma list without brackets', () => {
    expect(parseAliases('---\naliases: 阿尔法, alpha\n---\n')).toEqual(['阿尔法', 'alpha']);
  });

  it('reads a block list under the key', () => {
    const text = '---\ntitle: x\naliases:\n  - 阿尔法\n  - alpha\n---\n';
    expect(parseAliases(text)).toEqual(['阿尔法', 'alpha']);
  });

  it('accepts the singular alias key', () => {
    expect(parseAliases('---\nalias: 阿尔法\n---\n')).toEqual(['阿尔法']);
  });

  it('strips quotes around an alias', () => {
    expect(parseAliases('---\naliases: ["C++ 笔记"]\n---\n')).toEqual(['C++ 笔记']);
  });

  it('de-duplicates case-insensitively', () => {
    expect(parseAliases('---\naliases: [alpha, Alpha]\n---\n')).toEqual(['alpha']);
  });

  it('ignores the body, so prose cannot invent aliases', () => {
    const text = 'aliases: [nope]\n\n# Note\n\nSome text\naliases: [nope2]\n';
    expect(parseAliases(text)).toEqual([]);
  });

  it('ignores an unclosed frontmatter block', () => {
    expect(parseAliases('---\naliases: [a]\n# Title\n')).toEqual([]);
  });

  it('survives empty and non-string input', () => {
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases(null as unknown as string)).toEqual([]);
  });
});

describe('scanBlockIds', () => {
  it('finds an ASCII id at the end of a line, with the caption', () => {
    const blocks = scanBlockIds('先看结论 ^b7\n');
    expect(blocks).toEqual([{ id: 'b7', line: 1, text: '先看结论' }]);
  });

  it('rejects a non-ASCII id, which Obsidian would not accept either', () => {
    expect(scanBlockIds('第二段 ^结论\n')).toEqual([]);
  });

  it('finds an id on its own line', () => {
    expect(scanBlockIds('一段文字\n\n^standalone\n').map((b) => b.id)).toEqual(['standalone']);
  });

  it('ignores ids inside fenced code', () => {
    expect(scanBlockIds('```\nexample ^notreal\n```\n\nreal ^yes\n').map((b) => b.id)).toEqual(['yes']);
  });

  it('keeps the first occurrence of a duplicated id', () => {
    expect(scanBlockIds('a ^dup\n\nb ^dup\n').map((b) => b.line)).toEqual([1]);
  });

  it('requires the marker to end the line', () => {
    expect(scanBlockIds('a ^b7 trailing\n')).toEqual([]);
  });

  it('survives empty input', () => {
    expect(scanBlockIds('')).toEqual([]);
  });
});

describe('aliases in the resolution table', () => {
  const docs = [
    scanDocument(A, '---\naliases: [阿尔法, Alpha Note]\n---\n# Alpha\n'),
    scanDocument(B, '# Beta\nlink [[阿尔法]]\n')
  ];

  it('scanDocument exposes the parsed aliases', () => {
    expect(docs[0].aliases).toEqual(['阿尔法', 'Alpha Note']);
  });

  it('resolves a link written with an alias', () => {
    const index = buildIndex(docs);
    expect(resolveWikiPage(index.lookup, '阿尔法', A)).toEqual({ path: A, ambiguous: [] });
    expect(resolveWikiPage(index.lookup, 'alpha note', B)).toEqual({ path: A, ambiguous: [] });
  });

  it('counts the aliased link as a backlink', () => {
    const index = buildIndex(docs);
    const refs = index.backlinks[normalizePath(A)] ?? [];
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.some((r) => r.from === B)).toBe(true);
  });

  it('does not register an alias equal to the note name as a second candidate', () => {
    const lookup = buildWikiLookup([scanDocument(A, '---\naliases: [alpha]\n---\n')]);
    expect(lookup.byName.alpha).toEqual([A]);
  });

  it('reports ambiguity when two notes share an alias', () => {
    const withDup = [docs[0], scanDocument('C:\\vault\\gamma.md', '---\naliases: [阿尔法]\n---\n')];
    const lookup = buildWikiLookup(withDup);
    expect(lookup.byName['阿尔法']).toEqual([A, 'C:\\vault\\gamma.md']);
  });
});
