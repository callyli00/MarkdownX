import { describe, expect, it } from 'vitest';
import {
  headingSlug,
  isTagCandidate,
  maskFencedCode,
  parseWikiLink,
  relativeFromDoc,
  resolveWikiPage,
  scanTags,
  scanWikiLinks,
  wikiDisplayText,
  wikiHref,
  wikiKey,
  type WikiLookup
} from '../wikiLink';

describe('parseWikiLink', () => {
  it('parses a plain link', () => {
    const link = parseWikiLink('My Note', 'link')!;
    expect(link.page).toBe('My Note');
    expect(link.heading).toBe('');
    expect(link.alias).toBe('');
    expect(link.kind).toBe('link');
  });

  it('parses an alias', () => {
    const link = parseWikiLink('My Note|显示名', 'link')!;
    expect(link.page).toBe('My Note');
    expect(link.alias).toBe('显示名');
    expect(wikiDisplayText(link)).toBe('显示名');
  });

  it('parses a heading target', () => {
    const link = parseWikiLink('My Note#Some Heading', 'link')!;
    expect(link.page).toBe('My Note');
    expect(link.heading).toBe('Some Heading');
    expect(link.blockId).toBe('');
  });

  it('parses a block target', () => {
    const link = parseWikiLink('My Note#^abc-1', 'link')!;
    expect(link.page).toBe('My Note');
    expect(link.heading).toBe('');
    expect(link.blockId).toBe('abc-1');
  });

  it('parses a same-page heading link', () => {
    const link = parseWikiLink('#Local', 'link')!;
    expect(link.page).toBe('');
    expect(link.heading).toBe('Local');
  });

  it('treats a trailing number on an embed as a width, not an alias', () => {
    const link = parseWikiLink('assets/a.png|300', 'embed')!;
    expect(link.page).toBe('assets/a.png');
    expect(link.size).toBe(300);
    expect(link.alias).toBe('');
    expect(link.isImage).toBe(true);
  });

  it('supports alt text plus width on an embed', () => {
    const link = parseWikiLink('a.png|图注|480', 'embed')!;
    expect(link.alias).toBe('图注');
    expect(link.size).toBe(480);
  });

  it('does not treat a trailing number as a width on a plain link', () => {
    const link = parseWikiLink('note|300', 'link')!;
    expect(link.alias).toBe('300');
    expect(link.size).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(parseWikiLink('', 'link')).toBeNull();
    expect(parseWikiLink('a[b', 'link')).toBeNull();
    expect(parseWikiLink('a\nb', 'link')).toBeNull();
    expect(parseWikiLink('a'.repeat(600), 'link')).toBeNull();
    expect(parseWikiLink('https://x/y', 'link')).toBeNull();
  });

  it('accepts a path-shaped target', () => {
    expect(parseWikiLink('dir/note', 'link')!.page).toBe('dir/note');
    expect(parseWikiLink('assets/a.png', 'embed')!.isImage).toBe(true);
  });

  it('marks attachments', () => {
    expect(parseWikiLink('a.pdf', 'embed')!.isPdf).toBe(true);
    expect(parseWikiLink('a.mp3', 'embed')!.isAttachment).toBe(true);
    expect(parseWikiLink('a.md', 'embed')!.isAttachment).toBe(false);
  });
});

describe('headingSlug', () => {
  it('matches the renderer heading-id formula', () => {
    expect(headingSlug('Hello World')).toBe('hello-world');
    expect(headingSlug('  Spaced  Out ')).toBe('spaced-out');
    expect(headingSlug('中文 标题')).toBe(encodeURIComponent('中文-标题'));
  });
});

describe('wikiKey', () => {
  it('case-folds, strips extension and leading ./', () => {
    expect(wikiKey('Notes')).toBe('notes');
    expect(wikiKey('Notes.md')).toBe('notes');
    expect(wikiKey('./sub/Notes.md')).toBe('sub/notes');
  });
});

describe('resolveWikiPage', () => {
  const lookup: WikiLookup = {
    byName: {
      notes: ['C:\\v\\a\\notes.md', 'C:\\v\\b\\notes.md'],
      solo: ['C:\\v\\b\\solo.md']
    },
    byPath: { 'sub/notes.md': 'C:\\v\\sub\\notes.md' }
  };

  it('prefers a note in the same directory when the name is ambiguous', () => {
    expect(resolveWikiPage(lookup, 'Notes', 'C:\\v\\b\\other.md')!.path).toBe('C:\\v\\b\\notes.md');
    const r = resolveWikiPage(lookup, 'Notes', 'C:\\v\\c\\other.md')!;
    expect(r.path.length).toBeLessThan(40);
    expect(r.ambiguous.length).toBe(1);
  });

  it('resolves an explicit path', () => {
    expect(resolveWikiPage(lookup, 'sub/notes', 'C:\\v\\a.md')!.path).toBe('C:\\v\\sub\\notes.md');
  });

  it('returns null for unknown pages', () => {
    expect(resolveWikiPage(lookup, 'missing', 'C:\\v\\a.md')).toBeNull();
  });
});

describe('relativeFromDoc', () => {
  it('keeps the platform separator', () => {
    expect(relativeFromDoc('C:\\v\\a.md', 'C:\\v\\b.md')).toBe('b.md');
    expect(relativeFromDoc('C:\\v\\a.md', 'C:\\v\\sub\\b.md')).toBe('sub\\b.md');
    expect(relativeFromDoc('C:\\v\\sub\\a.md', 'C:\\v\\b.md')).toBe('..\\b.md');
    expect(relativeFromDoc('/sdcard/n/a.md', '/sdcard/b.md')).toBe('../b.md');
  });

  it('falls back to the absolute path across roots', () => {
    expect(relativeFromDoc('C:\\v\\a.md', 'D:\\x\\b.md')).toBe('D:\\x\\b.md');
  });
});

describe('wikiHref', () => {
  it('builds heading and block fragments', () => {
    const heading = parseWikiLink('B#Some Heading', 'link')!;
    expect(wikiHref('C:\\v\\a.md', 'C:\\v\\b.md', heading)).toBe('b.md#heading-some-heading');
    const block = parseWikiLink('B#^blk1', 'link')!;
    expect(wikiHref('C:\\v\\a.md', 'C:\\v\\b.md', block)).toBe('b.md#blk-blk1');
  });

  it('uses a bare fragment for same-page links', () => {
    const link = parseWikiLink('#Local', 'link')!;
    expect(wikiHref('C:\\v\\a.md', 'C:\\v\\a.md', link)).toBe('#heading-local');
  });
});

describe('maskFencedCode', () => {
  it('blanks fenced bodies but keeps offsets', () => {
    const src = 'a\n```\n[[in-code]]\n```\nb';
    const masked = maskFencedCode(src);
    expect(masked.length).toBe(src.length);
    expect(masked).not.toContain('[[in-code]]');
    expect(masked.split('\n')[0]).toBe('a');
  });

  it('handles an unterminated fence', () => {
    const src = 'a\n```\n[[x]]';
    expect(maskFencedCode(src)).not.toContain('[[x]]');
  });
});

describe('scanWikiLinks / scanTags', () => {
  it('collects links and skips fenced code', () => {
    const links = scanWikiLinks('see [[A]] and ![[img.png|200]]\n```\n[[B]]\n```\n[[C#H]]');
    expect(links.map((l) => l.page)).toEqual(['A', 'img.png', 'C']);
    expect(links[1].kind).toBe('embed');
  });

  it('ignores links and tags written as inline code examples', () => {
    // Found by the v2.7.0 smoke test: a note that DOCUMENTS the syntax was showing up as a
    // third backlink target for the very note it was documenting.
    const src = '示例 `[[B]]` 与 `#tag`，真正的 [[C]] 与 #real';
    expect(scanWikiLinks(src).map((l) => l.page)).toEqual(['C']);
    expect(scanTags(src)).toEqual(['real']);
  });

  it('collects tags but not headings, URLs, entities or escapes', () => {
    const tags = scanTags([
      '# Heading',
      'text #real and #嵌套/子',
      'url https://x/y#frag',
      'entity &#39;',
      'escaped \\#no',
      'number #123'
    ].join('\n'));
    expect(tags).toEqual(['real', '嵌套/子']);
  });
});

describe('isTagCandidate', () => {
  it('rejects heading markers and word-adjacent hashes', () => {
    expect(isTagCandidate('', 'Title')).toBe(true);
    expect(isTagCandidate('', ' Title')).toBe(false);
    expect(isTagCandidate('word', 'tag')).toBe(false);
    expect(isTagCandidate('&', '39;')).toBe(false);
  });
});
