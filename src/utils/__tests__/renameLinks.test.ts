import { describe, it, expect } from 'vitest';
import {
  planRenameReferences,
  rebuildInner,
  renamedPathFor,
  rewriteWikiLinks,
  stemOf
} from '../renameLinks';
import { buildIndex, scanDocument } from '../workspaceIndex';

const ROOT = 'C:\\vault';
const A = `${ROOT}\\alpha.md`;
const B = `${ROOT}\\beta.md`;

/** Index + a content source backed by a plain map, i.e. exactly what App passes in. */
function setup(files: Record<string, string>, renameOld: string, renameNew: string, skip: string[] = []) {
  const docs = Object.entries(files).map(([path, content]) => scanDocument(path, content));
  const index = buildIndex(docs);
  const getContent = (path: string) => files[path] ?? null;
  return { index, rewrites: planRenameReferences(index, renameOld, renameNew, getContent, skip) };
}

describe('rewriteWikiLinks', () => {
  it('rewrites only the tokens the decider accepts', () => {
    const result = rewriteWikiLinks('a [[one]] b [[two]]', (link) => (link.page === 'one' ? 'ONE' : null));
    expect(result.content).toBe('a [[ONE]] b [[two]]');
    expect(result.changes).toBe(1);
  });

  it('never touches a fenced code sample', () => {
    const text = '[[real]]\n\n```\n[[sample]]\n```\n';
    const result = rewriteWikiLinks(text, () => 'X');
    expect(result.content).toBe('[[X]]\n\n```\n[[sample]]\n```\n');
    expect(result.changes).toBe(1);
  });

  it('never touches an inline code span', () => {
    const result = rewriteWikiLinks('use `[[example]]` then [[real]]', () => 'X');
    expect(result.content).toBe('use `[[example]]` then [[X]]');
    expect(result.changes).toBe(1);
  });

  it('keeps embeds and their width', () => {
    const result = rewriteWikiLinks('![[pic.png|300]] and ![[pic.png]]', (link) =>
      rebuildInner(link, 'asset.png')
    );
    expect(result.content).toBe('![[asset.png|300]] and ![[asset.png]]');
    expect(result.changes).toBe(2);
  });

  it('reports zero changes without touching the text', () => {
    const result = rewriteWikiLinks('[[a]] [[b]]', () => null);
    expect(result.content).toBe('[[a]] [[b]]');
    expect(result.changes).toBe(0);
  });

  it('preserves CRLF line endings', () => {
    const result = rewriteWikiLinks('line1\r\n[[a]]\r\nline3\r\n', () => 'b');
    expect(result.content).toBe('line1\r\n[[b]]\r\nline3\r\n');
  });

  it('survives empty input', () => {
    expect(rewriteWikiLinks('', () => 'x')).toEqual({ content: '', changes: 0 });
    expect(rewriteWikiLinks(null as unknown as string, () => 'x').changes).toBe(0);
  });
});

describe('planRenameReferences', () => {
  const files = {
    [A]: '# alpha\n',
    [B]: 'links [[alpha]] here\n'
  };

  it('rewrites the referencing document', () => {
    const { rewrites } = setup(files, A, `${ROOT}\\alpha-2.md`);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].docPath).toBe(B);
    expect(rewrites[0].content).toBe('links [[alpha-2]] here\n');
    expect(rewrites[0].changes).toBe(1);
  });

  it('keeps the heading anchor', () => {
    const withHeading = { [A]: '# alpha\n', [B]: 'see [[alpha#应力张量]]\n' };
    const { rewrites } = setup(withHeading, A, `${ROOT}\\renamed.md`);
    expect(rewrites[0].content).toBe('see [[renamed#应力张量]]\n');
  });

  it('keeps the block anchor', () => {
    const withBlock = { [A]: 'text ^b7\n', [B]: 'see [[alpha#^b7]]\n' };
    const { rewrites } = setup(withBlock, A, `${ROOT}\\renamed.md`);
    expect(rewrites[0].content).toBe('see [[renamed#^b7]]\n');
  });

  it('keeps the display text', () => {
    const withDisplay = { [A]: '# alpha\n', [B]: 'see [[alpha|那篇笔记]]\n' };
    const { rewrites } = setup(withDisplay, A, `${ROOT}\\renamed.md`);
    expect(rewrites[0].content).toBe('see [[renamed|那篇笔记]]\n');
  });

  it('leaves same-note anchors alone', () => {
    const selfAnchor = { [A]: '# alpha\n[[#alpha]]\n' };
    const { rewrites } = setup(selfAnchor, A, `${ROOT}\\renamed.md`);
    expect(rewrites).toEqual([]);
  });

  it('leaves links to other notes alone', () => {
    const other = { [A]: '# a\n', [B]: '# b\n', [`${ROOT}\\c.md`]: 'x [[beta]]\n' };
    const { rewrites } = setup(other, A, `${ROOT}\\renamed.md`);
    expect(rewrites).toEqual([]);
  });

  it('rewrites links inside the renamed note itself', () => {
    const selfLink = { [A]: '# alpha\nsee [[alpha]]\n' };
    const { rewrites } = setup(selfLink, A, `${ROOT}\\renamed.md`);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].docPath).toBe(A);
    expect(rewrites[0].content).toBe('# alpha\nsee [[renamed]]\n');
  });

  it('writes a vault-relative path when the new name is ambiguous', () => {
    const dup = {
      [`${ROOT}\\a\\note.md`]: '# one\n',
      [`${ROOT}\\b\\other.md`]: '# other\n',
      [`${ROOT}\\c.md`]: 'see [[other]]\n'
    };
    // b/other.md -> b/note.md would collide with a/note.md
    const { rewrites } = setup(dup, `${ROOT}\\b\\other.md`, `${ROOT}\\b\\note.md`);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].content).toBe('see [[b/note]]\n');
  });

  it('skips documents the caller cannot rewrite', () => {
    const { rewrites } = setup(files, A, `${ROOT}\\alpha-2.md`, [B]);
    expect(rewrites).toEqual([]);
  });

  it('skips documents with no cached content', () => {
    const docs = [scanDocument(A, '# a\n'), scanDocument(B, 'x [[alpha]]\n')];
    const index = buildIndex(docs);
    expect(planRenameReferences(index, A, `${ROOT}\\z.md`, () => null)).toEqual([]);
  });

  it('returns nothing for a no-op rename or a missing index', () => {
    expect(setup(files, A, A).rewrites).toEqual([]);
    expect(planRenameReferences(null, A, `${ROOT}\\z.md`, () => 'x')).toEqual([]);
  });

  it('is a no-op when the new path has no stem', () => {
    const { rewrites } = setup(files, A, `${ROOT}\\`);
    expect(rewrites).toEqual([]);
  });
});

describe('stemOf', () => {
  it('strips directories and the extension', () => {
    expect(stemOf('C:\\vault\\notes\\daily.md')).toBe('daily');
    expect(stemOf('/storage/notes/daily.md')).toBe('daily');
    expect(stemOf('daily')).toBe('daily');
  });
});

describe('renamedPathFor', () => {
  it('keeps the extension when the user types only a name', () => {
    expect(renamedPathFor('C:\\vault\\daily.md', '2026-10-26')).toBe('C:\\vault\\2026-10-26.md');
  });

  it('honours an explicit extension', () => {
    expect(renamedPathFor('C:\\vault\\daily.md', 'daily.txt')).toBe('C:\\vault\\daily.txt');
  });

  it('turns separators in the typed name into dashes', () => {
    expect(renamedPathFor('C:\\vault\\daily.md', 'a/b\\c')).toBe('C:\\vault\\a-b-c.md');
  });

  it('does not invent an extension for an extensionless file', () => {
    expect(renamedPathFor('C:\\vault\\LICENSE', 'NOTICE')).toBe('C:\\vault\\NOTICE');
  });

  it('works for POSIX paths', () => {
    expect(renamedPathFor('/storage/notes/daily.md', 'tomorrow')).toBe('/storage/notes/tomorrow.md');
  });

  it('returns empty for missing input', () => {
    expect(renamedPathFor('', 'x')).toBe('');
    expect(renamedPathFor('C:\\vault\\a.md', '  ')).toBe('');
  });
});
